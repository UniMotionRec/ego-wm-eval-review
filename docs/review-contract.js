export const dimensions = ["P", "C", "M"];
export const channels = ["source", "execution", "timing", "physics"];
export const statuses = { pending: "待评", evaluated: "已评", skipped: "已跳过", blocked: "待修复", stale: "需重审" };
export const unknownReasons = [
  { code: "source_occluded", label_zh: "源示范看不清" },
  { code: "execution_occluded", label_zh: "机器人画面看不清" },
  { code: "reference_missing", label_zh: "源参考缺少此项" },
  { code: "evidence_gap", label_zh: "现有证据无法确定" },
];
export const isDigest = (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const isId = (value) => typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value);
export const isTime = (value) => Number.isFinite(value) && value >= 0;
const isIndex = (value) => Number.isSafeInteger(value) && value >= 0;
export const isWindow = (value) => Array.isArray(value) && value.length === 2 && value.every(isTime) && value[1] >= value[0];
const near = (a, b, epsilon = 0.000002) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= epsilon;
const distinct = (rows) => new Set(rows).size === rows.length;
const require = (condition, message) => { if (!condition) throw new Error(message); };

function hasPartialSource(row) {
  const coverage = row.timeline.source_coverage ?? "complete";
  require(["complete", "partial"].includes(coverage), "源帧覆盖范围声明无效。");
  if (coverage === "partial") {
    const card = row.task_card;
    const scopes = Object.entries(card?.requirements ?? {});
    const sourceScopes = scopes.length ? scopes.filter(([dimension, rules]) =>
      ["C", "M"].includes(dimension) || rules.some((rule) =>
        rule.evidence_options.every((option) => option.includes("source"))))
      .map(([dimension]) => card.dimension_scopes?.[dimension] ?? card.scope_id)
      : [card?.scope_id, ...Object.values(card?.dimension_scopes ?? {})];
    require(card?.scope_id && !sourceScopes.includes("full_episode"), "局部源帧证据需要较窄的审阅范围。");
  }
  return coverage === "partial";
}

export function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  throw new Error("数据含有不可用于证据签名的值。");
}

async function bytesDigest(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "sha256:" + Array.from(digest, (x) => x.toString(16).padStart(2, "0")).join("");
}
export const digest = (value) => bytesDigest(new TextEncoder().encode(canonical(value)));
export const blobDigest = async (blob) => bytesDigest(await blob.arrayBuffer());

export function validateV2Shape(manifest, row) {
  const card = row.task_card;
  const timeline = row.timeline;
  require(card && ["diagnostic", "acceptance"].includes(card.review_mode) && isId(card.scope_id) &&
    isId(card.profile_id) && isId(card.protocol_id) && Array.isArray(card.allowed_correspondence_ids) &&
    card.allowed_correspondence_ids.length > 0 && distinct(card.allowed_correspondence_ids) &&
    card.allowed_correspondence_ids.every(isId) && Array.isArray(card.required_dimensions) &&
    card.required_dimensions.length > 0 && distinct(card.required_dimensions) &&
    card.required_dimensions.every((key) => ["V", ...dimensions].includes(key)),
  "任务卡缺少有效的范围、评审要求或允许对应。");
  const numbers = ["source_duration_s", "execution_duration_s", "source_video_offset_s",
    "execution_video_offset_s", "preparation_s", "uniform_scale"];
  require(timeline && numbers.every((key) => isTime(timeline[key])) &&
    timeline.source_duration_s > 0 && timeline.execution_duration_s > 0 && timeline.uniform_scale > 0 &&
    isWindow(timeline.score_window_s) && timeline.score_window_s[1] > timeline.score_window_s[0] &&
    ["identity", "declared"].includes(timeline.time_policy),
  "批次未声明完整的源、回放与物理时钟。");
  require(timeline.time_policy !== "identity" || (timeline.source_video_offset_s === 0 &&
    timeline.execution_video_offset_s === 0 && timeline.preparation_s === 0 && timeline.uniform_scale === 1),
  "时间映射与声明的同速、同起点规则冲突。");
  hasPartialSource(row);
  const hashes = row.media_hashes;
  require(hashes && Object.keys(row.media).every((key) => isDigest(hashes[key])) &&
    Object.keys(hashes).every((key) => Boolean(row.media[key])) &&
    ["case_fingerprint", "task_card_hash", "evidence_hash", "time_mapping_hash", "trace_binding_hash"]
      .every((key) => isDigest(row[key])),
  "素材或任务卡缺少版本签名。");
  const requirementIds = new Set();
  for (const key of dimensions) {
    const rows = card.requirements?.[key] ?? [];
    require(Array.isArray(rows) && Boolean(rows.length) === card.required_dimensions.includes(key),
      "必要维度没有定义可审阅的要求，或不适用维度仍有题目。");
    const failureCodes = new Set();
    for (const req of rows) {
      require(isId(req.id) && req.id.startsWith(key + ".") && !requirementIds.has(req.id) &&
        typeof req.label_zh === "string" && req.label_zh.trim() && isId(req.failure_code) &&
        !failureCodes.has(req.failure_code) && (req.window_s == null ||
          (isWindow(req.window_s) && req.window_s[0] >= timeline.score_window_s[0] - .000002 &&
            req.window_s[1] <= timeline.score_window_s[1] + .000002)) &&
        ["event_anchor", "window"].includes(req.failure_evidence) &&
        Array.isArray(req.evidence_options) && req.evidence_options.length &&
        req.evidence_options.every((option) => Array.isArray(option) && option.length && distinct(option) &&
          option.every((name) => channels.includes(name))),
      "任务卡含有重复要求、越界时间或无法解释的证据要求。");
      require(!req.unknown_reasons || Array.isArray(req.unknown_reasons) &&
        req.unknown_reasons.every((reason) => isId(reason.code) && typeof reason.label_zh === "string"),
      "任务卡无法解释缺证据原因。");
      requirementIds.add(req.id);
      failureCodes.add(req.failure_code);
    }
  }
  require(assignedDimensions(row).every((key) => card.required_dimensions.includes(key)),
    "当前指派包含不适用的题目。");
  const correspondence = row.assigned_correspondence_id ?? card.review_correspondence_id;
  require(correspondence ? card.allowed_correspondence_ids.includes(correspondence) :
    card.allowed_correspondence_ids.length === 1, "指派缺少可供整段共用的手部对应。");
  require(manifest.review_schema_version === 2 && isId(manifest.assignment_id) &&
    ["independent", "arbiter"].includes(manifest.assignment_role) && Array.isArray(manifest.reviewer_ids) &&
    manifest.reviewer_ids.length === (manifest.assignment_role === "arbiter" ? 1 : 2) &&
    distinct(manifest.reviewer_ids) && manifest.reviewer_ids.every(isId),
  "审阅包缺少有效的批次指派。");
}

export async function checkCaseIdentity(row) {
  const [card, evidence, mapping] = await Promise.all([
    digest(row.task_card),
    digest({ media_hashes: row.media_hashes, trace_binding_hash: row.trace_binding_hash }),
    digest({ timeline: row.timeline, timestamps_sha256: row.media_hashes.timestamps ?? null,
      source_timestamps_sha256: row.media_hashes.source_timestamps ?? null }),
  ]);
  require(card === row.task_card_hash && evidence === row.evidence_hash && mapping === row.time_mapping_hash,
    "任务卡、素材或时间映射与批次签名不一致。");
  const signature = await digest({ review_schema_version: 2, blind_id: row.blind_id,
    task_card_hash: card, evidence_hash: evidence, time_mapping_hash: mapping,
    trace_binding_hash: row.trace_binding_hash });
  require(signature === row.case_fingerprint, "案例内容与题目标识不一致。");
}

export function parseJSONL(text) {
  return text.trim().split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

export function validateFrameMaps(execution, source, row, frozenTrial = false) {
  require(execution.length, "回放逐帧索引为空。");
  const timeline = row.timeline;
  const partial = hasPartialSource(row);
  require(source.length || timeline.source_mapping_available === false, "源视频逐帧索引为空。");
  const sourceByFrame = new Map();
  let prev;
  for (const point of source) {
    require(isIndex(point.source_frame_id) && isTime(point.source_video_pts_s) && isTime(point.source_time_s) &&
      (!prev || point.source_frame_id > prev.source_frame_id && point.source_video_pts_s > prev.source_video_pts_s &&
        point.source_time_s >= prev.source_time_s) &&
        point.source_video_pts_s <= timeline.source_video_offset_s + timeline.source_duration_s + .002,
    "源视频帧索引时间倒退、重复或越界。");
    sourceByFrame.set(point.source_frame_id, point);
    prev = point;
  }
  prev = null;
  const [start, end] = timeline.score_window_s;
  const dt = timeline.physics_dt_s ?? .005;
  const declaredSupport = timeline.source_trace_support_s;
  if (declaredSupport !== undefined) {
    require(Array.isArray(declaredSupport) && declaredSupport.every((span, i) => isWindow(span) &&
      span[0] >= Math.max(start, timeline.preparation_s) - .000002 && span[1] <= end + .000002 &&
      (!i || span[0] > declaredSupport[i - 1][1])), "源帧支持窗口无效。");
  }
  for (const point of execution) {
    const src = sourceByFrame.get(point.source_frame_id);
    const repeated = Boolean(prev && point.state_index === prev.state_index);
    const outsideScore = point.trace_time_s < Math.max(timeline.preparation_s, start) - .000002 ||
      point.trace_time_s > end + .000002;
    require(isIndex(point.execution_frame_id) && isTime(point.execution_video_pts_s) &&
      isTime(point.trace_time_s) && isIndex(point.state_index) &&
      (point.state_index === 0 ? point.transition_index == null : point.transition_index === point.state_index - 1) &&
      (point.repeat_state === true) === repeated && (!repeated || near(point.trace_time_s, prev.trace_time_s)) &&
      (!prev || point.execution_frame_id > prev.execution_frame_id &&
        point.execution_video_pts_s > prev.execution_video_pts_s && point.state_index >= prev.state_index &&
        (repeated ? near(point.trace_time_s, prev.trace_time_s) : point.trace_time_s > prev.trace_time_s)) &&
      point.execution_video_pts_s <= timeline.execution_video_offset_s + timeline.execution_duration_s + .002 &&
      point.trace_time_s <= (timeline.native_trace_end_s ?? end + dt) + .000002 &&
      (src ? near(point.source_video_pts_s, src.source_video_pts_s) && near(point.source_time_s, src.source_time_s) :
        point.source_frame_id == null && point.source_video_pts_s == null && point.source_time_s == null &&
        (timeline.source_mapping_available === false || outsideScore ||
          point.source_mapping_status === "presentation_tail" ||
          partial && point.source_mapping_status === "unsupported")),
    "回放帧索引有无效状态、对应帧或未声明的重复。");
    prev = point;
  }
  const allPaired = source.length > 0 && execution.every((point) => point.source_frame_id != null ||
    point.trace_time_s < Math.max(timeline.preparation_s, start) - .000002 ||
    point.trace_time_s > end + .000002);
  const linked = allPaired && (declaredSupport === undefined || declaredSupport.some(([a,b]) =>
    a <= Math.max(timeline.preparation_s, start) + .000002 && b >= end - .000002));
  const sourceSupport = declaredSupport ?? (linked ? [[Math.max(start, timeline.preparation_s), end]] : null);
  if (declaredSupport !== undefined) {
    require(execution.every((point) =>
      (point.source_frame_id != null) === declaredSupport.some(([a, b]) =>
        a - .000002 <= point.trace_time_s && point.trace_time_s <= b + .000002)), "逐帧索引与源支持窗口不符。");
  }
  const clockWindow = [execution[0].trace_time_s, execution.at(-1).trace_time_s];
  if (frozenTrial) require(clockWindow[0] <= start + dt + .000002 && near(clockWindow[1], end, dt + .000002),
    "回放帧索引未覆盖评分时间。");
  return { execution, source, linked, clockWindow, sourceSupport };
}

export function validatePhysical(rows, timing, row) {
  require(rows.length > 0, "物理记录为空。");
  const byTransition = new Map();
  let previous;
  for (const record of rows) {
    const interval = record.solver_interval_s;
    require(isIndex(record.transition_index) && isWindow(interval) && interval[1] > interval[0] &&
      near(record.state_time_s, interval[1]) && (previous == null || record.transition_index > previous.transition_index &&
        near(interval[0], previous.state_time_s)) && typeof record.contacts_available === "boolean" &&
      Array.isArray(record.object_contacts), "物理记录的步编号、采样覆盖或接触状态无效。");
    byTransition.set(record.transition_index, record);
    previous = record;
  }
  const [start, end] = row.timeline.score_window_s;
  const nativeEnd = row.timeline.native_trace_end_s ?? end;
  require(rows[0].solver_interval_s[0] <= start + .000002 &&
    near(rows.at(-1).state_time_s, nativeEnd) && nativeEnd + .000002 >= end &&
    nativeEnd - end <= (row.timeline.physics_dt_s ?? .005) + .000002 &&
    (!timing || timing.execution.every((point) => point.transition_index == null ||
      near(byTransition.get(point.transition_index)?.state_time_s, point.trace_time_s))),
  "物理记录与评分窗口或帧映射不一致。");
  return byTransition;
}

export const assignedDimensions = (row) => row.review_dimensions ??
  dimensions.filter((key) => row.task_card.required_dimensions.includes(key));
export const requirementWindow = (row, req) => req.window_s ?? row.timeline.score_window_s;
export const evidenceAlternative = (req, availability) => req.evidence_options.find(
  (option) => option.every((channel) => availability[channel] === "valid"));

export function skippedBy(row, decisions) {
  if (row.task_card.review_mode !== "acceptance") return {};
  const assignments = assignedDimensions(row);
  const gates = row.gates ?? {};
  const validFail = (key) => decisions[key]?.verdict === "fail" || gates[key]?.verdict === "fail";
  let cause;
  if (gates.V?.verdict === "fail") cause = "V";
  else if (validFail("P")) cause = "P";
  else if (validFail("C") && (row.task_card.allowed_correspondence_ids.length === 1 ||
      gates.C?.all_correspondences_failed === true || decisions.C?.mapping_independent === true)) cause = "C";
  if (!cause || row.diagnostic_failure_sample === true) return {};
  const downstream = cause === "V" ? dimensions : cause === "P" ? ["C", "M"] : ["M"];
  return Object.fromEntries(downstream.filter((key) => assignments.includes(key) &&
      !decisions[key]?.verdict).map((key) => [key, cause]));
}
