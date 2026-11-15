import { builtIn, fromFolder, fromZip } from "./bundle.js";

const nodes = Object.fromEntries([...document.querySelectorAll("[id]")].map((node) => [node.id, node]));
const vids = { source: nodes.source, execution: nodes.execution };
const choices = [
  ["functional", "P", "任务完成", "指定对象是否完成目标？检查必要事件、支撑、释放和末尾保持。"],
  ["contact", "C", "接触方式", "核对手别、指腹、物体部位与接触顺序。"],
  ["motion", "M", "动作过程", "核对运动路径、掌部朝向、关键阶段和时序。"],
];
const answers = [["pass", "符合"], ["fail", "偏离"], ["unknown", "无法判断"]];
const state = { provider: null, index: 0, drafts: {}, urls: [], generation: 0, request: 0,
  physical: null, frames: null, loadingPhysical: false };
const inputs = {};
let linked = false;
let storageAvailable = true;

function readStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { storageAvailable = false; return false; }
}
const profileKey = "ego-wm-review/v1/reviewer";
const manifest = () => state.provider?.manifest;
const cases = () => manifest()?.cases ?? [];
const current = () => cases()[state.index];
const profile = () => nodes.reviewer.value.trim();
const draftKey = () => `ego-wm-review/v1/${manifest().batch_id}/${profile() || "__draft__"}`;
const text = (item, contents) => { item.textContent = typeof contents === "string" ? contents : ""; };
const displayTime = (sec) => Number.isFinite(sec) ? `${Math.max(0, sec).toFixed(2)} s` : "—";
const asSeconds = (x, fallback = 0) => Number.isFinite(x) ? x : fallback;
const printableOrdinal = (i) => String(i + 1).padStart(2, "0");

function notice(message, type = "info") {
  text(nodes.notice, message);
  nodes.notice.dataset.type = type;
  nodes.notice.hidden = !message;
}

function field(label, item, className) {
  const outer = document.createElement("label");
  outer.className = className ?? "";
  outer.append(label, item);
  return outer;
}
function makeInput(attributes) {
  const node = document.createElement("input");
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

for (const [key, code, label, description] of choices) {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "dimension";
  const row = document.createElement("div");
  row.className = "dim-row";
  const heading = document.createElement("div");
  const title = document.createElement("p");
  title.className = "dim-title";
  title.id = `${key}-heading`;
  const letter = document.createElement("span");
  letter.textContent = code;
  title.append(letter, label);
  const explain = document.createElement("p");
  explain.className = "dim-description";
  explain.id = `${key}-rubric`;
  explain.textContent = description;
  heading.append(title, explain);
  const options = document.createElement("div");
  options.className = "options";
  options.setAttribute("role", "radiogroup");
  options.setAttribute("aria-labelledby", title.id);
  options.setAttribute("aria-describedby", explain.id);
  const radios = answers.map(([value, short]) => {
    const radio = makeInput({ type: "radio", name: key, value });
    const span = document.createElement("span");
    span.textContent = key === "functional" ? ({ pass: "完成", fail: "未完成" }[value] ?? short) : short;
    const option = document.createElement("label");
    option.className = "option";
    option.append(radio, span);
    options.append(option);
    return radio;
  });
  row.append(heading, options);
  const support = document.createElement("div");
  support.className = "row-support";
  support.hidden = true;
  const reason = makeInput({ type: "text", maxlength: "1000", placeholder: "描述可见证据或缺少的信息", "aria-label": `${label}依据` });
  const start = makeInput({ type: "number", min: "0", step: "0.01", placeholder: "0.00", "aria-label": `${label}证据起点` });
  const end = makeInput({ type: "number", min: "0", step: "0.01", placeholder: "0.00", "aria-label": `${label}证据终点` });
  const stamp = document.createElement("button");
  stamp.type = "button";
  stamp.className = "secondary";
  stamp.textContent = "记时间";
  stamp.addEventListener("click", () => {
    const value = getEvidenceTime().toFixed(3);
    if (start.value === "" || Number(value) < Number(start.value)) start.value = value;
    if (end.value === "" || Number(value) > Number(end.value)) end.value = value;
    saveCurrent();
  });
  support.append(field("依据", reason, "reason"), field("起点 s", start, "time-input"),
    field("终点 s", end, "time-input"), stamp);
  fieldset.append(row, support);
  nodes.dimensions.append(fieldset);
  inputs[key] = { radios, explain, support, reason, start, end, fieldset };
}

function getDraft() {
  return state.drafts[current()?.blind_id] ?? { completed: false, details: {} };
}
function fieldValues() {
  const values = {};
  for (const [key, , ,] of choices) {
    const input = inputs[key];
    const value = input.radios.find((item) => item.checked)?.value ?? "";
    input.support.hidden = !value;
    values[key] = { value, reason: input.reason.value.trim(), start: input.start.value, end: input.end.value };
  }
  return values;
}
function saveCurrent(completed = false) {
  if (!current()) return;
  const details = fieldValues();
  state.drafts[current().blind_id] = { completed, details };
  const saved = writeStorage(draftKey(), state.drafts);
  text(nodes["save-status"], saved ? (completed ? "已完成" : "草稿已保存") : "仅当前页面保存");
  refreshQueue();
}
function updateForm() {
  const row = current();
  const draft = getDraft();
  for (const [key, , , fallback] of choices) {
    const input = inputs[key];
    const value = draft.details[key] ?? {};
    text(input.explain, row?.task?.rubric?.[key] || fallback);
    for (const option of input.radios) option.checked = option.value === value.value;
    input.reason.value = value.reason ?? "";
    input.start.value = value.start ?? "";
    input.end.value = value.end ?? "";
    input.support.hidden = !value.value;
    input.fieldset.classList.remove("invalid");
    input.fieldset.disabled = !row;
  }
  text(nodes["completion-error"], "");
  text(nodes["save-status"], draft.completed ? "已完成" :
    Object.values(draft.details).some((detail) => detail.value) ? "草稿已保存" : "");
  nodes.complete.disabled = !row;
  text(nodes.complete, draft.completed ? "保存修改并下一条 →" : "完成并下一条 →");
}

function refreshQueue() {
  const total = cases().length;
  const completed = cases().filter((row) => state.drafts[row.blind_id]?.completed).length;
  nodes.progress.value = completed;
  nodes.progress.max = total || 1;
  text(nodes["progress-text"], `${completed} / ${total} 已完成`);
  text(nodes["progress-percent"], total ? `${Math.round(100 * completed / total)}%` : "");
  nodes["case-list"].replaceChildren();
  cases().forEach((row, index) => {
    const draft = state.drafts[row.blind_id];
    const status = draft?.completed ? "complete" :
      Object.values(draft?.details ?? {}).some((detail) => detail.value) ? "draft" : "new";
    if (nodes.filter.checked && status === "complete" && index !== state.index) return;
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "case-button";
    button.setAttribute("aria-current", String(state.index === index));
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `${printableOrdinal(index)}  ${row.task.title || "审阅片段"}`;
    name.title = name.textContent;
    const badge = document.createElement("span");
    badge.className = "state";
    badge.dataset.status = status;
    badge.textContent = { complete: "完成", draft: "草稿", new: "待审" }[status];
    button.append(name, badge);
    button.addEventListener("click", () => {
      renderCase(index);
      nodes.workspace.focus({ preventScroll: true });
    });
    item.append(button);
    nodes["case-list"].append(item);
  });
  if (!nodes["case-list"].childElementCount) {
    const p = document.createElement("li");
    p.className = "queue-empty";
    p.textContent = total ? "已全部完成。" : "导入审阅包以开始。";
    nodes["case-list"].append(p);
  }
  nodes.export.disabled = !completed || !profile();
  text(nodes["export-count"], String(completed));
}

async function getAsset(key, generation) {
  const blob = await state.provider.fetchBlob(key);
  if (generation !== state.generation) return null;
  const url = URL.createObjectURL(blob);
  state.urls.push(url);
  return url;
}

function clearMedia() {
  for (const side of Object.keys(vids)) {
    const video = vids[side];
    video.pause();
    video.removeAttribute("src");
    delete video.dataset.programmedSeek;
    video.querySelectorAll("track").forEach((track) => track.remove());
    video.load();
  }
  for (const url of state.urls) URL.revokeObjectURL(url);
  state.urls = [];
  linked = false;
  text(nodes.play, "同时播放");
}
async function installVideo(side, row, generation) {
  nodes[`${side}-empty`].hidden = true;
  const video = vids[side];
  const filename = row?.media?.[side];
  if (!filename) {
    nodes[`${side}-empty`].hidden = false;
    return;
  }
  try {
    const url = await getAsset(filename, generation);
    if (generation !== state.generation) return;
    video.src = url;
    const captions = row.media[`${side}_captions`];
    if (captions) {
      const sub = await getAsset(captions, generation);
      if (sub && generation === state.generation) {
        const track = document.createElement("track");
        track.kind = "subtitles";
        track.label = "说明";
        track.srclang = "en";
        track.src = sub;
        video.append(track);
      }
    }
  } catch (error) {
    if (generation !== state.generation) return;
    notice(error.message, "error");
    nodes[`${side}-empty`].hidden = false;
  }
}

async function renderCase(idx) {
  if (idx < 0 || idx >= cases().length) return;
  state.index = idx;
  const generation = ++state.generation;
  clearMedia();
  const row = current();
  nodes.workspace.setAttribute("aria-busy", "true");
  text(nodes["case-counter"], `第 ${idx + 1} / ${cases().length} 条 · ${row.blind_id}`);
  text(nodes["case-title"], row.task.title || "审阅片段");
  text(nodes["case-description"], row.task.description);
  nodes.previous.disabled = idx === 0;
  nodes.next.disabled = idx + 1 >= cases().length;
  nodes["evidence-panel"].hidden = !row.media.physical_evidence;
  nodes["evidence-panel"].open = false;
  state.physical = null;
  state.frames = null;
  state.loadingPhysical = false;
  text(nodes["physical-status"], "展开后载入。");
  nodes["physical-table"].replaceChildren();
  nodes.seek.value = "0";
  updateForm();
  refreshQueue();
  writeStorage(`${draftKey()}/index`, idx);
  await Promise.all([...Object.keys(vids).map((side) => installVideo(side, row, generation)),
    loadFrameMap(row, generation)]);
  if (generation === state.generation) {
    nodes.workspace.setAttribute("aria-busy", "false");
    updateTransport();
  }
}

function loadDrafts() {
  state.drafts = readStorage(draftKey(), {});
  if (!state.drafts || typeof state.drafts !== "object") state.drafts = {};
}
async function setProvider(provider) {
  state.provider = provider;
  loadDrafts();
  text(nodes["batch-kind"], provider.isLocal ? "组内审阅批次" : "练习批次");
  text(nodes["batch-title"], manifest().title || manifest().batch_id);
  let index = Number(readStorage(`${draftKey()}/index`, 0));
  if (!Number.isInteger(index) || index < 0 || index >= cases().length) index = 0;
  await renderCase(index);
}
async function importFile(read, file) {
  if (!file) return;
  const request = ++state.request;
  try {
    notice("正在读取本地审阅包。");
    const provider = await read(file);
    if (request !== state.request) return;
    notice("");
    await setProvider(provider);
  } catch (error) {
    if (request === state.request) notice(error.message || "审阅包载入失败。", "error");
  }
}
async function loadDemo() {
  const request = ++state.request;
  try {
    const provider = await builtIn();
    if (request === state.request) await setProvider(provider);
  }
  catch (error) { notice(error.message, "error"); refreshQueue(); nodes.workspace.setAttribute("aria-busy", "false"); }
}

function startOffset(side) { return asSeconds(current()?.timeline?.[`${side}_video_offset_s`]); }
function duration(side) {
  const bound = current()?.timeline?.[`${side}_duration_s`];
  return Math.max(0, asSeconds(bound, asSeconds(vids[side].duration) - startOffset(side)));
}
function clamp(value, limit) { return Math.min(Math.max(value, 0), limit); }
function sourceAt(executionTime) {
  const spec = current()?.timeline ?? {};
  return clamp((executionTime - asSeconds(spec.preparation_s)) / asSeconds(spec.uniform_scale, 1), duration("source"));
}
function executionAt(sourceTime) {
  const spec = current()?.timeline ?? {};
  return clamp(asSeconds(spec.preparation_s) + sourceTime * asSeconds(spec.uniform_scale, 1), duration("execution"));
}
function setTime(side, logicalTime) {
  const video = vids[side];
  if (video.readyState < 1) return;
  const target = clamp(startOffset(side) + logicalTime, video.duration);
  if (Math.abs(video.currentTime - target) > .006) {
    video.dataset.programmedSeek = String(target);
    video.currentTime = target;
  }
}
function logicalTime(side) { return clamp(vids[side].currentTime - startOffset(side), duration(side)); }
function getExecutionTime() {
  return vids.execution.readyState >= 1 ? logicalTime("execution") : executionAt(logicalTime("source"));
}
function getEvidenceTime() {
  const time = vids.execution.currentTime;
  if (!state.frames?.length || vids.execution.readyState < 1) return getExecutionTime();
  let left = 0;
  let right = state.frames.length;
  while (left < right) {
    const mid = (left + right) >>> 1;
    if (state.frames[mid].video_time_s <= time + .0005) left = mid + 1;
    else right = mid;
  }
  return state.frames[Math.max(0, left - 1)].timestamp_s;
}
function seekTo(time) {
  setTime("execution", time);
  if (nodes.sync.checked || vids.execution.readyState < 1) setTime("source", sourceAt(time));
  updateTransport();
}
function updateTransport() {
  const time = getExecutionTime();
  nodes.seek.max = String(duration("execution") || duration("source") || 1);
  nodes.seek.value = String(time);
  text(nodes.position, displayTime(time));
  text(nodes["source-time"], displayTime(logicalTime("source")));
  text(nodes["execution-time"], displayTime(logicalTime("execution")));
  const active = Object.values(vids).some((video) => !video.paused && !video.ended);
  text(nodes.play, active ? "暂停" : "同时播放");
  renderPhysical();
}

async function togglePlayback() {
  const active = Object.values(vids).some((video) => !video.paused && !video.ended);
  if (active) {
    for (const video of Object.values(vids)) video.pause();
    linked = false;
    return;
  }
  const usable = Object.values(vids).filter((video) => video.src && video.readyState >= 1);
  if (!usable.length) return;
  const both = usable.length === 2;
  if (getExecutionTime() >= duration("execution") - .04) seekTo(0);
  if (nodes.sync.checked && both) setTime("source", sourceAt(getExecutionTime()));
  linked = nodes.sync.checked && both;
  const preparing = linked && getExecutionTime() < asSeconds(current()?.timeline?.preparation_s);
  const plays = usable.filter((video) => !preparing || video !== vids.source).map((video) => video.play());
  const outcome = await Promise.allSettled(plays);
  if (outcome.some((result) => result.status === "rejected")) notice("视频未开始，请使用各自播放器的播放按钮。");
  updateTransport();
}

for (const side of Object.keys(vids)) {
  const video = vids[side];
  video.addEventListener("loadedmetadata", () => {
    setTime(side, 0);
    updateRates();
    updateTransport();
  });
  video.addEventListener("timeupdate", () => {
    const now = logicalTime(side);
    const boundary = duration(side);
    if (boundary && now >= boundary - .01 && video.currentTime >= startOffset(side) + boundary - .01) {
      // Prevent the private raw source clip from wandering into a different task.
      if (startOffset(side) + boundary < video.duration - .01) video.pause();
    }
    if (side === "execution" && linked && !video.paused) {
      if (now < asSeconds(current()?.timeline?.preparation_s)) {
        if (!vids.source.paused) vids.source.pause();
        setTime("source", 0);
      } else if (sourceAt(now) < duration("source") - .02 && vids.source.paused && vids.source.readyState >= 1) {
        setTime("source", sourceAt(now));
        vids.source.play().catch(() => {});
      } else if (!vids.source.seeking && Math.abs(sourceAt(now) - logicalTime("source")) > .17) {
        setTime("source", sourceAt(now));
      }
    }
    updateTransport();
  });
  video.addEventListener("seeked", () => {
    const programmed = video.dataset.programmedSeek;
    delete video.dataset.programmedSeek;
    if (nodes.sync.checked && (programmed === undefined || Math.abs(Number(programmed) - video.currentTime) > .07)) {
      if (side === "execution") setTime("source", sourceAt(logicalTime("execution")));
      else setTime("execution", executionAt(logicalTime("source")));
    }
    updateTransport();
  });
  video.addEventListener("pause", updateTransport);
  video.addEventListener("play", updateTransport);
  video.addEventListener("ended", () => {
    if (linked && side === "execution") vids.source.pause();
    if (side === "execution") linked = false;
    updateTransport();
  });
  video.addEventListener("error", () => {
    if (!video.getAttribute("src")) return;
    text(nodes[`${side}-empty`], "视频无法播放，可重新导入审阅包。");
    nodes[`${side}-empty`].hidden = false;
  });
}
function updateRates() {
  const rate = Number(nodes.rate.value);
  vids.execution.playbackRate = rate;
  vids.source.playbackRate = Math.max(.0625, clamp(
    rate / (nodes.sync.checked ? asSeconds(current()?.timeline?.uniform_scale, 1) : 1), 4));
}
nodes.sync.addEventListener("change", () => { if (!nodes.sync.checked) linked = false; updateRates(); });
nodes.rate.addEventListener("change", updateRates);
nodes.seek.addEventListener("input", () => seekTo(Number(nodes.seek.value)));
nodes.rewind.addEventListener("click", () => seekTo(getExecutionTime() - 1));
nodes.forward.addEventListener("click", () => seekTo(getExecutionTime() + 1));
nodes.play.addEventListener("click", togglePlayback);
nodes.previous.addEventListener("click", () => renderCase(state.index - 1));
nodes.next.addEventListener("click", () => renderCase(state.index + 1));
nodes.filter.addEventListener("change", refreshQueue);

async function loadPhysical() {
  const path = current()?.media?.physical_evidence;
  if (!path || !nodes["evidence-panel"].open || state.physical || state.loadingPhysical) return;
  const generation = state.generation;
  state.loadingPhysical = true;
  try {
    const blob = await state.provider.fetchBlob(path);
    const raw = await blob.text();
    const tracks = raw.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    if (generation === state.generation) {
      state.physical = tracks.filter((track) => Number.isFinite(track.state_time_s));
      renderPhysical();
    }
  } catch {
    if (generation === state.generation) text(nodes["physical-status"], "物理记录读入失败。");
  } finally {
    if (generation === state.generation) state.loadingPhysical = false;
  }
}
async function loadFrameMap(row, generation) {
  const path = row.media.timestamps;
  if (!path) return;
  try {
    const blob = await state.provider.fetchBlob(path);
    const frames = (await blob.text()).split(/\r?\n/).filter((line) => line.trim())
      .map((line) => JSON.parse(line)).filter(
        (sample) => Number.isFinite(sample.video_time_s) && Number.isFinite(sample.timestamp_s));
    if (generation === state.generation) state.frames = frames.sort((a, b) => a.video_time_s - b.video_time_s);
  } catch {
    if (generation === state.generation) notice("逐帧索引无法读取。记时间将使用回放播放器时间。");
  }
}
function renderPhysical() {
  if (!nodes["evidence-panel"].open || !state.physical) return;
  const target = getEvidenceTime();
  const row = state.physical.find((record) => record.solver_interval_s?.[0] <= target + .000001 &&
    record.solver_interval_s?.[1] > target - .000001);
  const parent = nodes["physical-table"];
  if (!row) {
    text(nodes["physical-status"], "该时间没有物理记录。");
    parent.replaceChildren();
    return;
  }
  if (parent.dataset.frame === String(row.state_time_s) && parent.childElementCount) return;
  parent.dataset.frame = row.state_time_s;
  text(nodes["physical-status"], `状态 t = ${displayTime(row.state_time_s)} · ${row.contacts_available ? "求解器接触" : "接触证据缺失"}`);
  const list = (row.object_contacts ?? []).filter((sample) => sample.active).sort((a, b) => (b.normal_force_N ?? 0) - (a.normal_force_N ?? 0)).slice(0, 8);
  parent.replaceChildren();
  if (!list.length) return;
  const table = document.createElement("table");
  const add = (values, cellType) => {
    const r = table.insertRow();
    for (const value of values) {
      const c = document.createElement(cellType);
      c.textContent = value;
      r.append(c);
    }
  };
  add(["手部或支撑", "物体区域", "法向力"], "th");
  for (const sample of list) add([sample.support_instance_id ?? [sample.hand_id, sample.hand_region].filter(Boolean).join(" · "),
    sample.patch_id || "—", Number.isFinite(sample.normal_force_N) ? `${sample.normal_force_N.toFixed(2)} N` : "—"], "td");
  parent.replaceChildren(table);
}
nodes["evidence-panel"].addEventListener("toggle", loadPhysical);

function check(values) {
  if (!profile() || profile() === "__draft__") {
    nodes.reviewer.focus();
    return "先填写审阅人编号。";
  }
  for (const [key, , label] of choices) {
    const item = values[key];
    if (!item.value) {
      inputs[key].radios[0].focus();
      inputs[key].fieldset.classList.add("invalid");
      return `请判断「${label}」。`;
    }
    const completeRange = item.start !== "" && item.end !== "" &&
      Number(item.start) >= 0 && Number(item.end) >= Number(item.start) &&
      (duration("execution") <= 0 || Number(item.end) <= duration("execution") + .02);
    if (!item.reason || (item.value !== "unknown" || item.start !== "" || item.end !== "") && !completeRange) {
      inputs[key].fieldset.classList.add("invalid");
      inputs[key][item.reason ? "start" : "reason"].focus();
      return `「${label}」需要${item.value === "unknown" && item.start === "" && item.end === ""
        ? "不可判的原因" : "原因和有效时间区间"}。`;
    }
  }
  return "";
}
function chooseNext(index) {
  const ordered = [...cases().slice(index + 1), ...cases().slice(0, index)];
  const row = ordered.find((item) => !state.drafts[item.blind_id]?.completed);
  return row ? cases().indexOf(row) : -1;
}
nodes["review-form"].addEventListener("input", (event) => {
  event.target.closest("fieldset")?.classList.remove("invalid");
  text(nodes["completion-error"], "");
  saveCurrent();
});
nodes["review-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  if (!current()) return;
  const error = check(fieldValues());
  text(nodes["completion-error"], error);
  if (error) return;
  saveCurrent(true);
  const index = chooseNext(state.index);
  if (index >= 0) {
    notice("");
    renderCase(index);
    nodes.workspace.focus({ preventScroll: true });
    nodes.workspace.scrollIntoView({ block: "start", behavior: "instant" });
  } else {
    notice("这个批次已全部完成。点击上方「导出标注」，把文件交回组织者。");
    nodes.export.focus();
  }
});
nodes.reviewer.value = readStorage(profileKey, "");
let lastProfile = profile();
nodes.reviewer.addEventListener("change", () => {
  writeStorage(profileKey, profile());
  if (!manifest() || lastProfile === profile()) return;
  // An unnamed draft can be attached to a first reviewer. Named reviewers keep separate records.
  const unnamed = !lastProfile ? state.drafts : null;
  loadDrafts();
  if (unnamed && profile()) {
    state.drafts = { ...unnamed, ...state.drafts };
    writeStorage(draftKey(), state.drafts);
  }
  lastProfile = profile();
  updateForm();
  refreshQueue();
});

function exportLabels() {
  if (!profile() || !manifest()) return;
  const labels = cases().flatMap((row) => {
    const draft = state.drafts[row.blind_id];
    if (!draft?.completed) return [];
    const output = { blind_id: row.blind_id, reviewer_id: profile(), batch_id: manifest().batch_id,
      role: manifest().assignment_role === "arbiter" ? "arbiter" : "independent" };
    for (const [key] of choices) {
      const item = draft.details[key];
      output[key] = { value: item.value, observable: item.value !== "unknown", reason: item.reason,
        evidence_intervals_s: item.start === "" ? [] : [[Number(item.start), Number(item.end)]] };
    }
    return [JSON.stringify(output)];
  });
  if (!labels.length) return;
  const blob = new Blob([labels.join("\n"), "\n"], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${manifest().batch_id}-${profile().replace(/[^\p{L}\p{N}_.-]/gu, "_")}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  notice(`已导出 ${labels.length} 条标注。导出文件可以交回组织者。`);
}
nodes.export.addEventListener("click", exportLabels);
nodes["import-zip"].addEventListener("click", () => nodes["zip-file"].click());
nodes["import-folder"].addEventListener("click", () => nodes["folder-files"].click());
nodes["zip-file"].addEventListener("change", (event) => {
  importFile(fromZip, event.target.files[0]);
  event.target.value = "";
});
nodes["folder-files"].addEventListener("change", (event) => {
  const files = [...event.target.files];
  if (files.length) importFile(fromFolder, files);
  event.target.value = "";
});
nodes["help-toggle"].addEventListener("click", () => nodes.help.showModal());
nodes["open-demo"].addEventListener("click", () => { nodes.help.close(); notice(""); loadDemo(); });
document.addEventListener("keydown", (event) => {
  if (nodes.help.open || ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "VIDEO"].includes(event.target.tagName) ||
    event.ctrlKey || event.metaKey || event.altKey || !current()) return;
  if (event.code === "Space") { event.preventDefault(); togglePlayback(); }
  if (event.key.toLowerCase() === "j") seekTo(getExecutionTime() - 1);
  if (event.key.toLowerCase() === "l") seekTo(getExecutionTime() + 1);
});
if (!storageAvailable) notice("此浏览器禁用了本地草稿。请在关闭页面前导出。");
loadDemo();
