import { checkCaseIdentity, dimensions as v2Dimensions, validateV2Shape } from "./review-contract.js?v=20261115-3";

const decoder = new TextDecoder("utf-8", { fatal: true });
const types = {
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  json: "application/json", jsonl: "application/x-ndjson", vtt: "text/vtt",
};
const dimensions = ["functional", "contact", "motion"];

function relative(path) {
  return typeof path === "string" && path.length > 0 &&
    !/[\\%?#:\x00-\x1f]/.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..");
}

export function validateManifest(data, has = () => true) {
  if (![1, 2].includes(data?.schema_version) || typeof data.batch_id !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(data.batch_id) ||
      !Array.isArray(data.cases) || !data.cases.length) {
    throw new Error("审阅包缺少有效的批次或任务清单。");
  }
  const v2 = data.schema_version === 2;
  const seen = new Set();
  for (const row of data.cases) {
    if (typeof row?.blind_id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(row.blind_id) ||
        seen.has(row.blind_id) || !(v2 ? row.task_card : row.task) || !row.media ||
        typeof row.media !== "object" || Array.isArray(row.media)) {
      throw new Error("任务编号重复或清单格式不正确。");
    }
    seen.add(row.blind_id);
    if (row.review_dimensions != null) {
      const assigned = row.review_dimensions;
      if (data.assignment_role !== "arbiter" || !Array.isArray(assigned) || assigned.length === 0 ||
          assigned.some((key) => !(v2 ? v2Dimensions : dimensions).includes(key)) ||
          new Set(assigned).size !== assigned.length) {
        throw new Error("分歧复核任务缺少有效的判断项。");
      }
    }
    for (const [key, value] of Object.entries(row.media)) {
      if (value != null && (!relative(value) || !v2 && !has(value))) {
        throw new Error(`任务 ${row.blind_id} 的 ${key} 文件缺失。`);
      }
    }
    if (v2) {
      validateV2Shape(data, row);
      continue;
    }
    const timeline = row.timeline ?? {};
    if (Object.values(timeline).some((t) => !Number.isFinite(t) || t < 0) || timeline.uniform_scale === 0) {
      throw new Error(`任务 ${row.blind_id} 的时间轴无效。`);
    }
  }
  return data;
}

function findManifest(paths) {
  const manifests = [...paths].filter((key) => key.split("/").at(-1) === "review-manifest.json");
  if (manifests.length !== 1) throw new Error("请选择包含一个 review-manifest.json 的审阅包。");
  const key = manifests[0];
  return [key, key.slice(0, key.length - "review-manifest.json".length)];
}

async function localProvider(entries, read) {
  const [key, prefix] = findManifest(entries.keys());
  const data = JSON.parse(await (await read(key)).text());
  const manifest = validateManifest(data, (path) => entries.has(prefix + path));
  if (manifest.schema_version === 2) await Promise.all(manifest.cases.map(checkCaseIdentity));
  return { manifest, kind: "local", fetchBlob: (path) => {
    if (!entries.has(prefix + path)) throw new Error("审阅包中的这个文件缺失。");
    return read(prefix + path);
  } };
}

export function fromFolder(files) {
  const entries = new Map([...files].map((file) => [file.webkitRelativePath || file.name, file]));
  return localProvider(entries, (key) => entries.get(key));
}

export async function fromZip(file) {
  const tailOffset = Math.max(0, file.size - 65557);
  const tail = new DataView(await file.slice(tailOffset).arrayBuffer());
  let end = tail.byteLength - 22;
  while (end >= 0 && (tail.getUint32(end, true) !== 0x06054b50 ||
    end + 22 + tail.getUint16(end + 20, true) !== tail.byteLength)) end -= 1;
  if (end < 0) throw new Error("ZIP 文件末尾不完整，请重新下载。");
  const count = tail.getUint16(end + 10, true);
  const size = tail.getUint32(end + 12, true);
  const offset = tail.getUint32(end + 16, true);
  if (count === 0xffff || offset + size > tailOffset + end || tail.getUint16(end + 4, true)) {
    throw new Error("请把这份 ZIP 解压后用「选择文件夹」导入。");
  }
  const directory = new DataView(await file.slice(offset, offset + size).arrayBuffer());
  const entries = new Map();
  let position = 0;
  for (let i = 0; i < count; i++) {
    if (position + 46 > directory.byteLength || directory.getUint32(position, true) !== 0x02014b50) {
      throw new Error("ZIP 文件目录损坏。");
    }
    const nameLength = directory.getUint16(position + 28, true);
    const extraLength = directory.getUint16(position + 30, true);
    const commentLength = directory.getUint16(position + 32, true);
    if (position + 46 + nameLength + extraLength + commentLength > size) throw new Error("ZIP 文件目录截断。");
    const path = decoder.decode(new Uint8Array(directory.buffer, position + 46, nameLength));
    if (relative(path)) {
      if (entries.has(path)) throw new Error("ZIP 内含重复的文件路径。");
      entries.set(path, {
        flags: directory.getUint16(position + 8, true),
        method: directory.getUint16(position + 10, true),
        size: directory.getUint32(position + 20, true),
        rawSize: directory.getUint32(position + 24, true),
        start: directory.getUint32(position + 42, true),
      });
    }
    position += 46 + nameLength + extraLength + commentLength;
  }

  async function read(path) {
    const row = entries.get(path);
    if (!row || row.start + 30 > offset || row.flags & 1) throw new Error("审阅包有缺失或加密文件。");
    const header = new DataView(await file.slice(row.start, row.start + 30).arrayBuffer());
    if (header.getUint32(0, true) !== 0x04034b50) throw new Error("ZIP 文件入口损坏。");
    const start = row.start + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    if (start + row.size > offset) throw new Error("ZIP 文件内容截断。");
    const type = types[path.split(".").at(-1).toLowerCase()] || "";
    const bytes = file.slice(start, start + row.size, type);
    if (row.method === 0) return bytes;
    if (row.method === 8 && typeof DecompressionStream === "function") {
      try {
        const decoded = await new Response(bytes.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
        if (decoded.size === row.rawSize) return new Blob([decoded], { type });
      } catch {
        // Folder import is available on browsers without raw DEFLATE decoding.
      }
    }
    throw new Error("无法在此浏览器解压该文件，请使用「选择文件夹」。");
  }
  return localProvider(entries, read);
}

async function readHosted(url, parse) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const retry = attempt === 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), retry ? 9000 : 6000);
    try {
      const address = new URL(url);
      if (retry) address.searchParams.set("retry", "1");
      const response = await fetch(address, { signal: controller.signal, cache: retry ? "reload" : "default" });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      return await parse(response);
    } catch (error) {
      if (retry) throw new Error("连接超时或素材暂时无法载入。", { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function builtIn(kind = "review") {
  const base = new URL({ demo: "./demo/", legacy: "./review/", review: "./review-v2/" }[kind], import.meta.url);
  const manifest = validateManifest(await readHosted(new URL("review-manifest.json", base), (response) => response.json()));
  if (manifest.schema_version === 2) await Promise.all(manifest.cases.map(checkCaseIdentity));
  const cache = new Map();
  async function fetchBlob(path) {
    if (!cache.has(path)) {
      cache.set(path, readHosted(new URL(path, base), (response) => response.blob()).catch((error) => {
        cache.delete(path);
        throw error;
      }));
    }
    return cache.get(path);
  }
  return { manifest, fetchBlob, kind: kind === "legacy" ? "review" : kind };
}
