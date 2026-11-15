import { blobDigest, parseJSONL, validateFrameMaps, validatePhysical } from "./review-contract.js";

const clamp = (value, limit) => Math.min(Math.max(value, 0), limit);
const text = (node, value) => { node.textContent = value; };
const time = (value) => Number.isFinite(value) ? value.toFixed(3) + " s" : "—";
const groupsFor = (contacts) => {
  const groups = new Map();
  for (const contact of contacts) {
    const actor = contact.support_instance_id ??
      ([contact.hand_id, contact.hand_region].filter(Boolean).join(" · ") || "未分组");
    const part = contact.patch_id === "whole_object" ? "物体整体（部位未区分）" : contact.patch_id || "部位未记录";
    const key = JSON.stringify([actor, part, Boolean(contact.active)]);
    if (!groups.has(key)) groups.set(key, { actor, part, active: contact.active, count: 0, maxForce: null });
    const group = groups.get(key);
    group.count += 1;
    const force = contact.normal_force_N;
    if (Number.isFinite(force) && (group.maxForce === null || force > group.maxForce)) group.maxForce = force;
  }
  return [...groups.values()];
};

export class ReviewPlayer {
  constructor(nodes, onStatus) {
    this.nodes = nodes;
    this.videos = { source: nodes.source, execution: nodes.execution };
    this.onStatus = onStatus;
    this.generation = 0;
    this.urls = [];
    this.availability = {};
    this.verified = new WeakMap();
    for (const [side, video] of Object.entries(this.videos)) {
      for (const event of ["play", "pause", "ended"]) {
        video.addEventListener(event, () => this.paint());
      }
      video.addEventListener("timeupdate", () => this.advance(side));
      video.addEventListener("seeked", () => this.onSeeked(side));
      video.addEventListener("loadedmetadata", () => this.metadata(side));
      video.addEventListener("loadeddata", () => this.markVideo(side));
      video.addEventListener("error", () => {
        if (video.getAttribute("src")) this.videoError(side);
      });
    }
    nodes.play.addEventListener("click", () => this.toggle());
    nodes.seek.addEventListener("input", () => this.seek(Number(nodes.seek.value)));
    nodes.rewind.addEventListener("click", () => this.seek(this.position() - 1));
    nodes.forward.addEventListener("click", () => this.seek(this.position() + 1));
    nodes["frame-prev"].addEventListener("click", () => this.step(-1));
    nodes["frame-next"].addEventListener("click", () => this.step(1));
    nodes["view-select"].addEventListener("change", () => this.changeView());
    nodes.rate.addEventListener("change", () => this.rates());
    nodes.sync.addEventListener("change", () => {
      if (!nodes.sync.checked) this.linked = false;
      this.rates();
      this.paint();
    });
    nodes["evidence-panel"].addEventListener("toggle", () => this.renderPhysical());
    nodes["physical-step"].addEventListener("input", () => this.renderPhysical());
    document.addEventListener("keydown", (event) => {
      if (!this.row || nodes.help.open || nodes["problem-dialog"].open ||
        /^(INPUT|TEXTAREA|SELECT|BUTTON|VIDEO)$/.test(event.target.tagName) || event.target.isContentEditable ||
        event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.code === "Space") { event.preventDefault(); this.toggle(); }
      if (event.key.toLowerCase() === "j") this.seek(this.position() - 1);
      if (event.key.toLowerCase() === "l") this.seek(this.position() + 1);
      if (event.key === "," || event.key === ".") { event.preventDefault(); this.step(event.key === "," ? -1 : 1); }
    });
  }

  async verifiedBlob(key) {
    const path = this.row.media[key];
    const hash = this.row.media_hashes[key];
    if (!path || !hash) throw new Error("本条资料没有提供这份素材。");
    const provider = this.provider;
    if (!this.verified.has(provider)) this.verified.set(provider, new Map());
    const cache = this.verified.get(provider);
    const identity = path + "#" + hash;
    if (!cache.has(identity)) {
      cache.set(identity, Promise.resolve(provider.fetchBlob(path)).then(async (blob) => {
        if (await blobDigest(blob) !== hash) throw new Error("素材内容与批次签名不同。");
        return blob;
      }).catch((error) => { cache.delete(identity); throw error; }));
    }
    return cache.get(identity);
  }

  clearVideo(video) {
    if (video._reviewFrame != null) video.cancelVideoFrameCallback?.(video._reviewFrame);
    video._reviewFrame = null;
    video.pause();
    video.removeAttribute("src");
    delete video.dataset.programmedSeek;
    video.removeAttribute("data-batch-generation");
    video.load();
  }

  async load(provider, row) {
    this.row = row;
    this.provider = provider;
    const generation = ++this.generation;
    this.frames = null;
    this.physics = null;
    this.decoded = { source: null, execution: null };
    this.availability = Object.fromEntries(["source", "execution", "timing", "physics"].map((key) => [key, "unverified"]));
    this.frameTarget = null;
    this.rawSteps = [];
    this.nextStart = {};
    this.linked = false;
    this.view = "execution";
    this.lastPhysical = null;
    this.nodes["view-select"].value = "execution";
    this.nodes["view-select-label"].hidden = !row.media.execution_closeup;
    this.nodes["evidence-panel"].hidden = !row.media.physical_evidence;
    this.nodes["evidence-panel"].open = false;
    this.nodes["physical-table"].replaceChildren();
    for (const video of Object.values(this.videos)) this.clearVideo(video);
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    this.paint();
    const timing = this.loadMaps(generation);
    await Promise.all([
      this.loadVideo("source", "source", generation),
      this.loadVideo("execution", "execution", generation),
      timing, timing.then(() => this.loadPhysics(generation)),
    ]);
    if (generation === this.generation) this.paint();
  }

  async loadVideo(side, key, generation) {
    const video = this.videos[side];
    this.nodes[side + "-empty"].hidden = true;
    try {
      const blob = await this.verifiedBlob(key);
      if (generation !== this.generation) return;
      const url = URL.createObjectURL(blob);
      this.urls.push(url);
      video.dataset.batchGeneration = String(generation);
      video.src = url;
      this.capture(side, generation);
    } catch {
      if (generation === this.generation) this.videoError(side);
    }
  }

  async loadMaps(generation) {
    try {
      const usesSource = Boolean(this.row.media.source_timestamps);
      const [execution, source] = await Promise.all([
        this.verifiedBlob("timestamps").then(async (file) => parseJSONL(await file.text())),
        usesSource ? this.verifiedBlob("source_timestamps").then(async (file) => parseJSONL(await file.text())) : [],
      ]);
      if (generation !== this.generation) return;
      this.frames = validateFrameMaps(execution, source, this.row, this.provider.manifest.usability_trial === true);
      this.availability.timing = this.frames.linked ? "valid" : "unavailable";
    } catch {
      if (generation === this.generation) this.availability.timing = "unavailable";
    }
    if (generation === this.generation) this.updated();
  }

  async loadPhysics(generation) {
    if (generation !== this.generation) return;
    try {
      const file = await this.verifiedBlob("physical_evidence");
      const lines = parseJSONL(await file.text());
      if (generation !== this.generation) return;
      this.physics = validatePhysical(lines, this.frames, this.row);
      this.rawSteps = [...this.physics.keys()];
      this.nodes["physical-step"].max = String(this.rawSteps.length - 1);
      this.nodes["physical-step"].value = "0";
      this.availability.physics = "valid";
    } catch {
      if (generation === this.generation) this.availability.physics = "unavailable";
    }
    if (generation === this.generation) this.updated();
  }

  videoError(side) {
    this.availability[side] = "unavailable";
    const label = this.nodes[side + "-empty"];
    label.hidden = false;
    text(label, "素材缺失、内容不符或无法播放");
    this.updated();
  }

  markVideo(side) {
    const video = this.videos[side];
    if (video.dataset.batchGeneration !== String(this.generation)) return;
    if (video.duration + .04 < this.offset(side) + this.duration(side)) {
      this.videoError(side);
      return;
    }
    this.availability[side] = "valid";
    this.updated();
  }

  capture(side, generation) {
    const video = this.videos[side];
    if (typeof video.requestVideoFrameCallback !== "function") return;
    video._reviewFrame = video.requestVideoFrameCallback((_, metadata) => {
      if (generation !== this.generation || video.dataset.batchGeneration !== String(generation)) return;
      this.decoded[side] = metadata.mediaTime;
      if (side === "execution") this.paint();
      this.capture(side, generation);
    });
  }

  offset(side) { return this.row?.timeline[side + "_video_offset_s"] ?? 0; }
  duration(side) { return this.row?.timeline[side + "_duration_s"] ?? 0; }
  sourceAt(value) {
    const { preparation_s, uniform_scale } = this.row.timeline;
    return clamp((value - preparation_s) / uniform_scale, this.duration("source"));
  }
  executionAt(value) {
    const { preparation_s, uniform_scale } = this.row.timeline;
    return clamp(preparation_s + value * uniform_scale, this.duration("execution"));
  }
  position(side = "execution") {
    return clamp(this.videos[side].currentTime - this.offset(side), this.duration(side));
  }
  objectTime(side, position) {
    const video = this.videos[side];
    if (video.readyState < 1) return;
    const next = clamp(this.offset(side) + position, Math.max(0, video.duration - .0001));
    if (Math.abs(video.currentTime - next) > .0008) {
      this.decoded[side] = null;
      video.dataset.programmedSeek = String(next);
      video.currentTime = next;
    }
  }
  metadata(side) {
    if (!this.row || this.videos[side].dataset.batchGeneration !== String(this.generation)) return;
    this.objectTime(side, this.nextStart[side] ?? 0);
    delete this.nextStart[side];
    this.rates();
    this.paint();
  }
  pause() {
    this.linked = false;
    for (const video of Object.values(this.videos)) video.pause();
  }
  async toggle() {
    if (!this.row) return;
    if (Object.values(this.videos).some((video) => !video.paused)) {
      this.pause();
      return;
    }
    if (this.position() >= this.duration("execution") - .018) this.seek(0);
    const preparing = this.availability.execution === "valid" && this.canSync() &&
      this.position() < this.row.timeline.preparation_s;
    this.linked = this.canSync();
    if (this.linked) this.objectTime("source", this.sourceAt(this.position()));
    await Promise.allSettled(Object.entries(this.videos).filter(([side]) =>
      this.availability[side] === "valid" && !(preparing && side === "source"))
      .map(([, video]) => video.play()));
    this.paint();
  }
  canSync() {
    return this.availability.timing === "valid" && this.nodes.sync.checked;
  }
  rates() {
    const rate = Number(this.nodes.rate.value);
    this.videos.execution.playbackRate = rate;
    const effective = rate / (this.canSync() ? this.row.timeline.uniform_scale : 1);
    this.videos.source.playbackRate = Math.max(.0625, Math.min(4, effective));
  }
  seek(position) {
    if (!this.row) return;
    this.frameTarget = null;
    this.objectTime("execution", position);
    if (this.canSync()) this.objectTime("source", this.sourceAt(position));
    this.paint();
  }
  onSeeked(side) {
    const programmed = this.videos[side].dataset.programmedSeek;
    delete this.videos[side].dataset.programmedSeek;
    if (programmed === undefined) {
      this.frameTarget = null;
      if (this.canSync()) {
        if (side === "execution") this.objectTime("source", this.sourceAt(this.position()));
        else this.objectTime("execution", this.executionAt(this.position("source")));
      }
    }
    this.paint();
  }
  advance(side) {
    const video = this.videos[side];
    if (!this.row || !video.getAttribute("src")) return;
    if (this.position(side) >= this.duration(side) - .006 &&
      this.offset(side) + this.duration(side) < video.duration - .006) video.pause();
    if (side === "execution" && this.linked && !video.paused) {
      const target = this.sourceAt(this.position());
      if (this.position() < this.row.timeline.preparation_s) {
        this.videos.source.pause();
        this.objectTime("source", 0);
      } else if (target < this.duration("source") - .02) {
        if (Math.abs(target - this.position("source")) > .17 || this.videos.source.paused) this.objectTime("source", target);
        if (this.videos.source.paused && this.availability.source === "valid") this.videos.source.play().catch(() => {});
      }
    }
    this.paint();
  }
  frame() {
    if (!this.frames || this.videos.execution.seeking || !Number.isFinite(this.decoded.execution)) return null;
    return this.frames.execution.find((point) => Math.abs(point.execution_video_pts_s - this.decoded.execution) < .002) ?? null;
  }
  coversWindow(window) {
    const observed = this.frames?.clockWindow;
    return Boolean(observed && observed[0] <= window[0] + .05 && observed[1] >= window[1] - .05);
  }
  step(direction) {
    if (!this.frames || this.availability.execution !== "valid") return;
    this.pause();
    const rows = this.frames.execution;
    const point = this.frame();
    const mediaPosition = this.videos.execution.currentTime;
    const previous = this.frameTarget ?? (point ? rows.indexOf(point) :
      rows.findLastIndex((row) => row.execution_video_pts_s <= mediaPosition));
    this.frameTarget = clamp(previous + direction, rows.length - 1);
    const next = rows[this.frameTarget];
    const following = rows[this.frameTarget + 1]?.execution_video_pts_s;
    const center = following ? (next.execution_video_pts_s + following) / 2 : next.execution_video_pts_s + .0005;
    this.objectTime("execution", center - this.offset("execution"));
    if (this.canSync() && Number.isFinite(next.source_video_pts_s))
      this.objectTime("source", next.source_video_pts_s - this.offset("source") + .0005);
    this.paint();
  }
  async changeView() {
    const next = this.nodes["view-select"].value;
    if (!this.row?.media[next] || this.view === next) return;
    this.pause();
    this.nextStart.execution = this.position();
    this.decoded.execution = null;
    this.frameTarget = null;
    this.availability.execution = "unverified";
    this.clearVideo(this.videos.execution);
    this.view = next;
    await this.loadVideo("execution", next, this.generation);
    this.updated();
  }
  updated() {
    this.paint();
    this.onStatus();
  }
  paint() {
    if (!this.row) return;
    const point = this.frame();
    const timing = this.availability.timing;
    const videoReady = this.availability.execution === "valid";
    this.nodes.seek.disabled = !videoReady;
    this.nodes.seek.max = String(this.duration("execution"));
    this.nodes.seek.value = String(this.position());
    text(this.nodes.position, time(this.videos.execution.currentTime));
    text(this.nodes["source-time"], time(this.videos.source.currentTime));
    text(this.nodes["execution-time"], time(this.videos.execution.currentTime));
    text(this.nodes.play, Object.values(this.videos).some((video) => !video.paused) ? "暂停" : "播放");
    this.nodes.sync.disabled = timing !== "valid";
    this.nodes["frame-prev"].disabled = this.nodes["frame-next"].disabled =
      !videoReady || !this.frames || !this.videos.execution.requestVideoFrameCallback;
    this.nodes["timeline-status"].dataset.status = timing;
    text(this.nodes["timeline-status"], point
      ? "回放帧 " + point.execution_frame_id + " · " +
        (point.source_frame_id == null ? "源帧对应不可用" : "对应源帧 " + point.source_frame_id) +
        " · 物理 " + time(point.trace_time_s) + (point.repeat_state ? "（同一物理状态的尾帧）" : "") +
        (!this.provider.manifest.usability_trial &&
          !this.coversWindow(this.row.timeline.score_window_s) ? " · 回放覆盖评分窗口的一部分" : "")
      : timing === "unavailable" ? "时间对应不可用。两段视频仍可各自查看。"
      : timing === "valid" ? "时间索引已核验，等待已解码帧。" : "正在核对时间索引。");
    this.renderPhysical();
  }
  physicalReady(window) {
    if (!this.physics || !window) return false;
    const rows = [...this.physics.values()].filter((row) => row.state_time_s > window[0] - .000001 &&
      row.solver_interval_s[0] < window[1] + .000001);
    return rows.length > 0 && rows.every((row) => row.contacts_available);
  }
  selectedPhysical() {
    const point = this.frame();
    const index = point ? point.transition_index : this.rawSteps?.[Number(this.nodes["physical-step"].value)];
    return this.physics?.get(index) ?? null;
  }
  renderPhysical() {
    if (!this.nodes["evidence-panel"].open) return;
    const point = this.frame();
    const record = this.selectedPhysical();
    this.nodes["physical-step-control"].hidden = Boolean(point) || !this.physics;
    const table = this.nodes["physical-table"];
    if (!record) {
      this.lastPhysical = null;
      text(this.nodes["physical-status"], this.availability.timing !== "valid" ? "时间对应不可用，当前画面无法关联到求解器记录。"
        : this.availability.physics === "unavailable" ? "物理记录缺失或签名不符。"
          : "当前帧没有对应的已解码物理步。");
      table.replaceChildren();
      return;
    }
    if (this.lastPhysical === record) return;
    this.lastPhysical = record;
    const label = (point ? "" : "独立物理步 " + record.transition_index + " · ") +
      "积分区间 " + record.solver_interval_s.map(time).join(" 至 ");
    if (!record.contacts_available) {
      text(this.nodes["physical-status"], label + " · 接触证据不可用");
      table.replaceChildren();
      return;
    }
    const rows = record.object_contacts;
    const groups = groupsFor(rows);
    text(this.nodes["physical-status"], label + " · " + rows.length + " 条原始记录，" + groups.length + " 组");
    table.replaceChildren();
    if (!groups.length) return;
    const makeTable = (header, values) => {
      const element = document.createElement("table");
      for (const [index, row] of [header, ...values].entries()) {
        const tr = element.insertRow();
        for (const value of row) {
          const cell = index ? tr.insertCell() : document.createElement("th");
          cell.textContent = String(value);
          if (!index) { cell.scope = "col"; tr.append(cell); }
        }
      }
      return element;
    };
    const force = (value) => Number.isFinite(value) ? value.toFixed(3) + " N" : "未记录";
    const detail = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "展开全部原始接触";
    detail.append(summary, makeTable(["手部或支撑", "物体部位", "记录", "法向力"], rows.map((row) => {
      const [group] = groupsFor([row]);
      return [group.actor, group.part, group.active ? "求解器接触" : "邻近／无承载", force(row.normal_force_N)];
    })));
    table.append(makeTable(["手部或支撑", "物体部位", "记录", "数量", "最大法向力"], groups.map((group) =>
      [group.actor, group.part, group.active ? "求解器接触" : "邻近／无承载", group.count, force(group.maxForce)])), detail);
  }
}
