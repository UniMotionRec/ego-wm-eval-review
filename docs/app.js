import { builtIn, fromFolder, fromZip } from "./bundle.js?v=20261115-3";
import { assignedDimensions, channels, dimensions, requirementWindow, skippedBy,
  statuses, unknownReasons } from "./review-contract.js?v=20261115-3";
import { ReviewPlayer } from "./review-player.js?v=20261115-3";
import { addTrialMarker, ReviewMetrics } from "./review-metrics.js";
import { installTrialControls, loadTrialPage } from "./a1.js";

const ui = Object.fromEntries([...document.querySelectorAll("[id]")].map((node) => [node.id, node]));
const state = { provider: null, index: 0, request: 0, bucket: {}, draft: null };
const labels = { P: "任务目标", C: "接触策略", M: "运动过程" };
const verdictLabels = {
  P: { pass: "已完成", fail: "明确未完成", unknown: "证据不足" },
  C: { pass: "符合", fail: "存在明确偏离", unknown: "证据不足" },
  M: { pass: "符合", fail: "存在明确偏离", unknown: "证据不足" },
};
const issueChannels = {
  case_mismatch: channels, scope_conflict: channels, rule_conflict: channels,
  timeline_fault: ["timing"], other_material_issue: [],
};
const identityIssues = new Set(["case_mismatch", "scope_conflict", "rule_conflict"]);
const identityFields = ["case_fingerprint", "task_card_hash", "evidence_hash", "time_mapping_hash", "trace_binding_hash"];
const fields = {};
const manifest = () => state.provider?.manifest;
const cases = () => manifest()?.cases ?? [];
const row = () => cases()[state.index];
const reviewer = () => ui.reviewer.value;
const scoreWindow = () => row().timeline.score_window_s;
const text = (node, value) => { node.textContent = value ?? ""; };
const create = (tag, content, className) => {
  const element = document.createElement(tag);
  if (content != null) element.textContent = content;
  if (className) element.className = className;
  return element;
};
const makeButton = (content, className, action) => {
  const button = create("button", content, className);
  button.type = "button";
  button.addEventListener("click", action);
  return button;
};
const storageKey = () => "ego-wm-review/v2/" + manifest().batch_id + "/" + manifest().assignment_id +
  "/" + (reviewer() || "preview");
const initialDraft = () => ({ decisions: {}, issues: [], record: null });
const experiments = () => manifest()?.usability_trial === true;
const read = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
};
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}
function notice(message, type = "info") {
  text(ui.notice, message);
  ui.notice.dataset.type = type;
  ui.notice.hidden = !message;
}
function putDraft() {
  if (!row() || !reviewer()) return;
  const history = state.bucket[row().blind_id] ??= {};
  history[row().case_fingerprint] = state.draft;
  const saved = write(storageKey(), state.bucket);
  text(ui["save-status"], saved ? (state.draft.record ? "已保存" : "草稿已保存") : "草稿仅留在本页面");
}
const metrics = new ReviewMetrics("v2", (snapshot) => {
  if (!state.draft || !reviewer()) return;
  state.draft.metrics = snapshot;
  putDraft();
});
const player = new ReviewPlayer(ui, () => {
  refreshIdentity();
  if (!ui["review-form"].contains(document.activeElement)) updateFormStates();
});

function effectiveAvailability() {
  const result = { ...player.availability };
  for (const issue of state.draft.issues) {
    for (const key of issue.affected_channels) result[key] = "unavailable";
  }
  return result;
}
const coveredByReference = (requirement) =>
  !(row().task_card.reference_unresolved_requirement_ids ?? []).includes(requirement.id);

function optionStatuses(option, window, availability) {
  return option.map((channel) => channel === "timing" && availability.timing === "valid" &&
    option.includes("source") && !player.coversSource(window) ? "unavailable" : availability[channel]);
}

function windowAlternative(req) {
  const availability = effectiveAvailability();
  return req.evidence_options.some((option) =>
    optionStatuses(option, requirementWindow(row(), req), availability).every((status) => status === "valid"));
}

function attainedAlternative(req, kind, point, physical) {
  const availability = effectiveAvailability();
  const window = requirementWindow(row(), req);
  const timingWindow = kind === "event_anchor" && point ? [point.trace_time_s, point.trace_time_s] : window;
  return req.evidence_options.find((option) => optionStatuses(option, timingWindow, availability).every((status) => status === "valid") &&
    (kind === "event_anchor" || !option.includes("execution") || experiments() || player.coversWindow(window)) &&
    (!option.includes("physics") || (kind === "event_anchor" ? physical?.contacts_available :
      player.physicalReady(window))) &&
    (kind !== "event_anchor" || !option.includes("timing") || point));
}

function gatherEvidence(req, kind) {
  if (!coveredByReference(req)) return null;
  const window = requirementWindow(row(), req);
  const wholeScope = window.every((value, index) => Math.abs(value - scoreWindow()[index]) < .000002);
  const frame = player.frame();
  const physical = player.selectedPhysical();
  const alternative = attainedAlternative(req, kind, frame, physical);
  if (!alternative) return null;
  const base = { mapping_hash: row().time_mapping_hash, requirement_ids: [req.id], channels: alternative };
  if (kind !== "event_anchor") {
    const provenance = "reviewer_claim_over_frozen_scope";
    if (player.frames && !state.draft.issues.some((issue) => issue.affected_channels.includes("timing")) ||
      alternative.includes("physics"))
      return { ...base, kind, time_basis: "trace", interval_s: window, provenance };
    if (wholeScope && alternative.includes("execution")) {
      const timeline = row().timeline;
      return { ...base, kind, time_basis: "execution_media",
        interval_s: [timeline.execution_video_offset_s, timeline.execution_video_offset_s + timeline.execution_duration_s],
        provenance };
    }
    return null;
  }
  const within = (t) => t >= window[0] - .000002 && t <= window[1] + .000002;
  if (frame && within(frame.trace_time_s)) {
    return { ...base, kind, time_basis: "trace", trace_time_s: frame.trace_time_s,
      state_index: frame.state_index, transition_index: frame.transition_index,
      execution_video_pts_s: frame.execution_video_pts_s, execution_frame_id: frame.execution_frame_id,
      source_frame_id: frame.source_frame_id, provenance: "reviewer_selected" };
  }
  if (!alternative.includes("timing") && alternative.includes("physics") && physical && within(physical.state_time_s)) {
    return { ...base, kind: "physical_transition", time_basis: "trace", trace_time_s: physical.state_time_s,
      state_index: physical.transition_index + 1, transition_index: physical.transition_index, provenance: "reviewer_selected" };
  }
  if (wholeScope && !alternative.includes("timing") && !alternative.includes("physics") &&
      alternative.includes("execution") &&
      Number.isFinite(player.decoded.execution) && !player.videos.execution.seeking) {
    return { ...base, kind, time_basis: "execution_media", execution_video_pts_s: player.decoded.execution,
      provenance: "reviewer_selected" };
  }
  return null;
}

function untouchedState(key, skips) {
  const card = row().task_card;
  const requirements = card.requirements[key];
  if (card.setup_issue?.affected_dimensions.includes(key)) return "blocked";
  if (state.draft.issues.some((issue) => identityIssues.has(issue.code))) return "blocked";
  if (skips[key]) return "skipped";
  const availability = effectiveAvailability();
  const knownGap = requirements.some((req) =>
    req.evidence_options.every((option) => optionStatuses(option, requirementWindow(row(), req), availability)
      .includes("unavailable")));
  const unresolvedIssue = state.draft.issues.some((issue) => issue.code === "other_material_issue" ||
    issue.code === "media_unavailable" && !issue.affected_channels.length);
  if (knownGap || unresolvedIssue && !state.draft.decisions[key]?.verdict) return "blocked";
  return "pending";
}

function alternateStillValid(evidence) {
  const availability = effectiveAvailability();
  const window = evidence?.interval_s ?? [evidence?.trace_time_s, evidence?.trace_time_s];
  return evidence && optionStatuses(evidence.channels, window, availability).every((status) => status === "valid") &&
    (evidence.time_basis !== "trace" ||
      evidence.kind === "physical_transition" || player.frames &&
      !state.draft.issues.some((issue) => issue.affected_channels.includes("timing")) ||
      evidence.channels.includes("physics"));
}

function evaluate(key, skips) {
  const draft = state.draft.decisions[key] ?? {};
  const { task_card: card } = row();
  const contract = card.requirements[key];
  const base = { applicability: "required", scope_id: card.dimension_scopes?.[key] ?? card.scope_id,
    assessment_state: untouchedState(key, skips), verdict: null, evidence: [] };
  const invalidIdentity = state.draft.issues.some((issue) => identityIssues.has(issue.code)) ||
    card.setup_issue?.affected_dimensions.includes(key);
  if (invalidIdentity) return base;
  const unresolved = new Set(draft.unresolved ?? []);
  for (const req of contract) {
    if (!coveredByReference(req) || !windowAlternative(req)) unresolved.add(req.id);
  }
  const makeEvaluated = (verdict, codes, covered, decisive, unresolvedIds, evidence) => ({
    ...base, assessment_state: "evaluated", verdict, reason_codes: codes,
    covered_requirement_ids: covered, decisive_requirement_ids: decisive,
    unresolved_requirement_ids: unresolvedIds, evidence, note: draft.note ?? "",
  });
  if (draft.verdict === "pass") {
    const evidence = contract.map((req) => gatherEvidence(req, "reviewed_scope"));
    if (!unresolved.size && evidence.every(Boolean))
      return makeEvaluated("pass", [], contract.map((req) => req.id), [], [], evidence);
  }
  if (draft.verdict === "fail") {
    const reasons = draft.reasons.filter((reason) => {
      const req = contract.find((item) => item.id === reason.requirement_id);
      return req && coveredByReference(req) && (reason.evidence ?? []).some(alternateStillValid);
    });
    if (reasons.length) {
      const decisive = reasons.map((reason) => reason.requirement_id);
      return makeEvaluated("fail", reasons.map((reason) => reason.code), decisive, decisive,
        [...unresolved].filter((id) => !decisive.includes(id)),
        reasons.flatMap((reason) => reason.evidence.filter(alternateStillValid)));
    }
  }
  if (draft.verdict === "unknown" && draft.reasons.length && base.assessment_state !== "blocked") {
    const codes = [...new Set(draft.reasons.map((reason) => reason.code))];
    for (const reason of draft.reasons) unresolved.add(reason.requirement_id);
    return makeEvaluated("unknown", codes, [], [], [...unresolved], []);
  }
  if (base.assessment_state === "skipped") {
    base.skip_reason = "short_circuit_fail";
    base.skip_dependency = { dimension: skips[key], verdict: "fail", case_fingerprint: row().case_fingerprint };
  }
  return base;
}

function decisionStates() {
  const assigned = assignedDimensions(row());
  const beforeGates = Object.fromEntries(assigned.map((key) => [key, evaluate(key, {})]));
  const skips = skippedBy(row(), beforeGates);
  return Object.fromEntries(assigned.map((key) => [key, evaluate(key, skips)]));
}

function changeDraft(key, draft) {
  state.draft.decisions[key] = draft;
  state.draft.record = null;
  text(ui["completion-error"], "");
  putDraft();
  refreshQueue();
  updateFormStates();
}

function chooseVerdict(key, verdict) {
  if (!reviewer()) return;
  const prior = state.draft.decisions[key];
  if (prior?.verdict === verdict) return;
  if (prior?.verdict) metrics.add("verdict_revisions");
  changeDraft(key, { verdict, reasons: [], unresolved: [], note: "" });
  renderForm();
}

function formatAnchor(evidence) {
  if (evidence.interval_s) return evidence.interval_s.map((value) => value.toFixed(3) + " s").join(" 至 ");
  const point = evidence.trace_time_s ?? evidence.execution_video_pts_s;
  return point.toFixed(3) + " s" + (evidence.time_basis === "execution_media" ? " 视频" : " 物理");
}

function selectReason(key, req, code) {
  const decision = state.draft.decisions[key];
  const already = decision.reasons.findIndex((reason) => reason.requirement_id === req.id && reason.code === code);
  if (already >= 0 && decision.reasons.length > 1) {
    decision.reasons.splice(already, 1);
  } else if (already < 0) {
    const existing = decision.reasons.filter((reason) => reason.requirement_id !== req.id);
    const evidence = decision.verdict === "fail" ?
      gatherEvidence(req, req.failure_evidence === "window" ? "observation_window" : "event_anchor") : null;
    decision.reasons = [...existing, { requirement_id: req.id, code, evidence: evidence ? [evidence] : [] }];
    if (evidence?.kind === "event_anchor") player.pause();
  }
  changeDraft(key, decision);
  renderSupport(key);
  fields[key]?.support.querySelector("[aria-pressed=true]")?.focus({ preventScroll: true });
}

function evidencePicker(key, req, reason, target) {
  if (req.failure_evidence !== "event_anchor") return;
  const add = () => {
    const evidence = gatherEvidence(req, "event_anchor");
    if (!evidence) {
      text(ui["completion-error"], "请暂停在该反例对应的已解码画面，或查看可用的求解器记录。");
      return;
    }
    player.pause();
    const matched = reason.evidence.some((previous) => formatAnchor(previous) === formatAnchor(evidence));
    if (!matched) reason.evidence.push(evidence);
    changeDraft(key, state.draft.decisions[key]);
    renderSupport(key);
    fields[key].support.querySelector(".capture-anchor")?.focus({ preventScroll: true });
  };
  target.append(makeButton(reason.evidence.length ? "再记一帧" : "记当前反例帧", "link-button capture-anchor", add));
}

function renderSupport(key) {
  const { support } = fields[key];
  const decision = state.draft.decisions[key];
  support.replaceChildren();
  support.hidden = !decision?.verdict || decision.verdict === "pass";
  if (support.hidden) return;
  const required = row().task_card.requirements[key];
  const fail = decision.verdict === "fail";
  if (fail) {
    const buttons = create("div", null, "quick-reasons");
    for (const req of required) {
      const button = makeButton(req.failure_label_zh ?? req.label_zh, "secondary", () => selectReason(key, req, req.failure_code));
      button.setAttribute("aria-pressed", String(decision.reasons.some((reason) => reason.code === req.failure_code)));
      buttons.append(button);
    }
    support.append(buttons);
    for (const reason of decision.reasons) {
      const req = required.find((item) => item.id === reason.requirement_id);
      const line = create("div", null, "recorded-evidence");
      text(line, reason.evidence.length ? reason.evidence.map(formatAnchor).join(" · ") :
        req.failure_evidence === "window" ? "该观察区间证据不可用。" : "请定位到反例画面。");
      evidencePicker(key, req, reason, line);
      support.append(line);
    }
  } else {
    const knownUnavailable = required.filter((req) => !coveredByReference(req) ||
      !windowAlternative(req));
    const preferred = knownUnavailable.length ? knownUnavailable : required;
    const options = [];
    for (const req of preferred) {
      const configured = req.unknown_reasons?.length ? req.unknown_reasons : [{
        code: coveredByReference(req) ? "evidence_gap" : "reference_missing",
        label_zh: "无法核对：" + req.label_zh,
      }];
      for (const reason of configured) {
        options.push({ code: reason.code, label: reason.label_zh, req });
      }
    }
    if (preferred.length === 1 && !preferred[0].unknown_reasons?.length)
      options.splice(0, options.length, ...unknownReasons.map((reason) => ({
        code: reason.code, label: reason.label_zh, req: preferred[0],
      })));
    const buttons = create("div", null, "quick-reasons");
    for (const { code, label, req } of options) {
      const button = makeButton(label, "secondary", () => selectReason(key, req, code));
      button.setAttribute("aria-pressed", String(decision.reasons.some((reason) =>
        reason.requirement_id === req.id && reason.code === code)));
      buttons.append(button);
    }
    support.append(buttons);
  }
  const details = create("details", null, "optional-note");
  details.append(create("summary", fail ? "补充信息或备注（可选）" : "备注（可选）"));
  if (fail && required.length > 1) {
    const knownCount = create("p", "其他必要要求看不清时，可以一并标明。");
    details.append(knownCount);
    for (const req of required) {
      if (decision.reasons.some((reason) => reason.requirement_id === req.id)) continue;
      const label = create("label", null, "optional-requirement");
      const input = create("input");
      input.type = "checkbox";
      input.checked = decision.unresolved.includes(req.id);
      input.addEventListener("change", () => {
        decision.unresolved = required.filter(({ id }) =>
          id === req.id ? input.checked : decision.unresolved.includes(id)).map(({ id }) => id);
        changeDraft(key, decision);
      });
      label.append(input, document.createTextNode(req.label_zh));
      details.append(label);
    }
  }
  const note = create("textarea");
  note.rows = 2;
  note.maxLength = 500;
  note.value = decision.note;
  note.setAttribute("aria-label", labels[key] + "备注");
  note.addEventListener("input", () => {
    decision.note = note.value;
    state.draft.record = null;
    putDraft();
    refreshQueue();
  });
  details.append(note);
  support.append(details);
}

function renderForm() {
  ui.dimensions.replaceChildren();
  for (const key of Object.keys(fields)) delete fields[key];
  if (!row()) return;
  for (const key of assignedDimensions(row())) {
    const choice = state.draft.decisions[key];
    const fieldset = create("fieldset", null, "dimension");
    fieldset.dataset.dimension = key;
    const rowDisplay = create("div", null, "dim-row");
    const heading = create("div");
    const title = create("p", null, "dim-title");
    title.id = key + "-review-dimension";
    title.append(create("span", key), document.createTextNode(labels[key]));
    const requirements = create("ul", null, "task-requirements");
    for (const req of row().task_card.requirements[key]) {
      const item = create("li", req.label_zh);
      if (!coveredByReference(req)) item.append(create("span", "参考不足", "scope-badge"));
      requirements.append(item);
    }
    heading.append(title, requirements);
    const controls = create("div", null, "options");
    controls.role = "radiogroup";
    controls.setAttribute("aria-labelledby", title.id);
    for (const [value, label] of Object.entries(verdictLabels[key])) {
      const option = create("label", null, "option");
      const radio = create("input");
      radio.type = "radio";
      radio.name = key;
      radio.value = value;
      radio.checked = choice?.verdict === value;
      radio.addEventListener("change", () => {
        chooseVerdict(key, value);
        fields[key].fieldset.querySelector("input[type=radio]:checked")?.focus({ preventScroll: true });
      });
      option.append(radio, create("span", label));
      controls.append(option);
    }
    rowDisplay.append(heading, controls);
    const flow = create("p", null, "dimension-flow");
    flow.hidden = true;
    const support = create("div", null, "review-support");
    fieldset.append(rowDisplay, flow, support);
    ui.dimensions.append(fieldset);
    fields[key] = { fieldset, controls, flow, support };
    renderSupport(key);
  }
  updateFormStates();
}

function updateFormStates() {
  if (!row() || !state.draft) return;
  const decisions = decisionStates();
  for (const [key, parts] of Object.entries(fields)) {
    const decision = decisions[key];
    parts.fieldset.disabled = !reviewer();
    parts.fieldset.dataset.state = decision.assessment_state;
    parts.controls.hidden = decision.assessment_state === "skipped" ||
      Boolean(row().task_card.setup_issue?.affected_dimensions.includes(key)) ||
      state.draft.issues.some((issue) => identityIssues.has(issue.code));
    const transientChoice = state.draft.decisions[key]?.verdict;
    parts.support.hidden = parts.controls.hidden || !transientChoice || transientChoice === "pass";
    const tags = { skipped: "本项已跳过 · 已有前置明确失败", blocked: "所需材料或判据待修复" };
    parts.flow.hidden = !tags[decision.assessment_state];
    text(parts.flow, tags[decision.assessment_state]);
  }
  const stale = Object.keys(state.bucket[row().blind_id] ?? {}).some((id) => id !== row().case_fingerprint);
  if (!state.draft.record && stale && !Object.keys(state.draft.decisions).length) text(ui["save-status"], "素材已更新，需重审");
  else if (state.draft.record) text(ui["save-status"], "已保存");
  else if (Object.keys(state.draft.decisions).length) text(ui["save-status"], "草稿已保存");
  else text(ui["save-status"], "");
  const setup = row().task_card.setup_issue?.label_zh;
  const recorded = state.draft.issues.length ? "已记录 " + state.draft.issues.length + " 项材料问题。" : "";
  const issue = [setup, recorded].filter(Boolean).join(" ");
  text(ui["issue-status"], issue);
  ui["issue-status"].hidden = !issue;
  ui.complete.disabled = !reviewer() || ui.workspace.getAttribute("aria-busy") === "true";
  text(ui.complete, state.draft.record ? "保存修改并下一条 →" : "保存并下一条 →");
}

function statusForCase(entry) {
  const history = state.bucket[entry.blind_id] ?? {};
  const draft = history[entry.case_fingerprint];
  if (draft?.record) {
    const states = new Set(Object.values(draft.record.dimensions).map((record) => record.assessment_state));
    if (states.has("blocked")) return "blocked";
    if (states.has("skipped")) return "skipped";
    return "evaluated";
  }
  if (Object.keys(history).some((id) => id !== entry.case_fingerprint) && !Object.keys(draft?.decisions ?? {}).length)
    return "stale";
  return "pending";
}

function refreshQueue() {
  if (!manifest()) return;
  const totals = Object.fromEntries(Object.keys(statuses).map((key) => [key, 0]));
  ui["case-list"].replaceChildren();
  for (const [index, entry] of cases().entries()) {
    const status = statusForCase(entry);
    totals[status] += 1;
    if (ui.filter.checked && ["evaluated", "skipped"].includes(status) && index !== state.index) continue;
    const item = create("li");
    const button = makeButton(null, "case-button", () => {
      openCase(index);
      ui.workspace.focus({ preventScroll: true });
    });
    button.setAttribute("aria-current", String(index === state.index));
    const title = String(index + 1).padStart(2, "0") + "  " + titleFor(entry);
    const name = create("span", title, "name");
    name.title = title;
    const badge = create("span", statuses[status], "state");
    badge.dataset.status = status;
    button.append(name, badge);
    item.append(button);
    ui["case-list"].append(item);
  }
  const processed = totals.evaluated + totals.skipped + totals.blocked;
  ui.progress.value = processed;
  ui.progress.max = cases().length;
  text(ui["progress-text"], "已处理 " + processed + " / " + cases().length);
  text(ui["progress-states"], Object.entries(totals).filter(([, count]) => count)
    .map(([key, count]) => statuses[key] + " " + count).join(" · "));
  ui.export.disabled = !processed || !reviewer();
  text(ui["export-count"], String(processed));
}

const titleFor = (entry) => entry.title ?? entry.task_card.title_zh ?? entry.task?.title ?? entry.task_card.source_scope ?? "审阅片段";
function refreshIdentity() {
  const entry = row();
  if (!entry) return;
  const availability = player.row === entry ? player.availability : {};
  const evidenceStates = { valid: "已核验", unavailable: "不可用", unverified: "核验中" };
  const output = [
    ["源示范", evidenceStates[availability.source] ?? "核验中"],
    ["机器人回放", evidenceStates[availability.execution] ?? "核验中"],
    ["逐帧映射", evidenceStates[availability.timing] ?? "核验中"],
    ["物理记录", evidenceStates[availability.physics] ?? "核验中"],
    ["案例版本", entry.case_fingerprint],
    ["任务卡版本", entry.task_card_hash],
    ["素材版本", entry.evidence_hash],
    ["映射版本", entry.time_mapping_hash],
  ];
  ui["case-identity"].replaceChildren(...output.map(([key, value]) => {
    const element = create("div");
    element.append(create("dt", key), create("dd", value));
    return element;
  }));
}

async function openCase(index) {
  if (!cases()[index]) return;
  metrics.leave();
  state.index = index;
  const entry = row();
  state.draft = state.bucket[entry.blind_id]?.[entry.case_fingerprint] ?? initialDraft();
  ui.workspace.setAttribute("aria-busy", "true");
  text(ui["case-counter"], "第 " + (state.trialSession ? state.trialSession.position + 1 : index + 1) +
    " / " + (state.trialSession?.total ?? cases().length) + " 条");
  text(ui["case-title"], titleFor(entry));
  const card = entry.task_card;
  text(ui["task-goal"], card.task_goal_zh);
  text(ui["task-scope"], card.source_scope);
  text(ui["task-demonstration"], card.demonstration_constraints_zh);
  text(ui["task-adaptation"], card.adaptation_zh ?? card.allowed_adaptation_zh);
  ui["adaptation-row"].hidden = !ui["task-adaptation"].textContent;
  ui["task-brief"].hidden = ui["case-details"].hidden = false;
  ui["case-details"].open = false;
  ui.previous.disabled = index === 0;
  ui.next.disabled = index === cases().length - 1;
  ui["load-problem"].disabled = ui.later.disabled = !reviewer();
  text(ui["judgment-hint"], manifest().assignment_role === "arbiter" ? "按相同题目独立判断所列项目。"
    : card.review_mode === "acceptance" ? "先看任务目标，其他项目会按当前结论安排。"
    : "逐项独立判断任务目标、接触策略和运动过程。");
  text(ui["completion-error"], "");
  const loaded = player.load(state.provider, entry);
  renderForm();
  refreshIdentity();
  refreshQueue();
  addTrialMarker(metrics, experiments());
  if (reviewer()) {
    write(storageKey() + "/index", index);
    if (!state.draft.record) metrics.start(state.draft.metrics, entry.trial_position ?? index, experiments());
  }
  const generation = player.generation;
  await loaded;
  if (generation === player.generation) {
    ui.workspace.setAttribute("aria-busy", "false");
    updateFormStates();
  }
}

function setReviewer(id) {
  metrics.leave();
  state.reviewer = id;
  state.bucket = id ? read(storageKey(), {}) : {};
  if (!state.bucket || Array.isArray(state.bucket) || typeof state.bucket !== "object") state.bucket = {};
  if (id) write("ego-wm-review/v2/assignment/" + manifest().assignment_id, id);
  const index = read(storageKey() + "/index", state.index);
  openCase(Number.isInteger(index) && cases()[index] ? index : 0);
}

async function openBatch(load) {
  const request = ++state.request;
  notice("正在核对审阅批次。");
  try {
    const provider = await load();
    if (request !== state.request) return;
    if (provider.manifest.schema_version !== 2) throw new Error("这份是旧版审阅包，请在旧版对照页面打开。");
    metrics.leave();
    state.provider = provider;
    state.index = 0;
    text(ui["batch-kind"], manifest().assignment_role === "arbiter" ? "分歧复核" :
      provider.kind === "review" ? "开发盲审" : "审阅批次");
    text(ui["batch-title"], manifest().title ?? manifest().batch_id);
    const trialId = experiments() && manifest().trial_reviewer_id;
    const roster = manifest().reviewer_ids.filter((id) => !trialId || trialId === id);
    const prompt = create("option", "选择分配给你的编号");
    prompt.value = "";
    ui.reviewer.replaceChildren(prompt, ...roster.map((id) => {
      const option = create("option", id);
      option.value = id;
      return option;
    }));
    const pinned = new URLSearchParams(location.search).get("reviewer");
    const previous = read("ego-wm-review/v2/assignment/" + manifest().assignment_id, "");
    const selected = [trialId, pinned, previous].find((id) => roster.includes(id)) ?? "";
    ui.reviewer.disabled = Boolean(trialId);
    ui.reviewer.value = selected;
    ui["open-default"].hidden = provider.kind === "review";
    notice("");
    setReviewer(selected);
  } catch (error) {
    if (request !== state.request) return;
    notice(error.message || "暂时无法打开审阅批次。", "error");
    if (!manifest()) ui.workspace.setAttribute("aria-busy", "false");
  }
}

function nextPending(index) {
  for (let delta = 1; delta < cases().length; delta++) {
    const candidate = (index + delta) % cases().length;
    const entry = cases()[candidate];
    if (!state.bucket[entry.blind_id]?.[entry.case_fingerprint]?.record) return candidate;
  }
  return -1;
}
function continueReview() {
  const next = nextPending(state.index);
  if (next >= 0) {
    openCase(next);
    ui.workspace.focus({ preventScroll: true });
    ui.workspace.scrollIntoView({ block: "start", behavior: "instant" });
  } else {
    notice("已处理本批次的任务。导出一个文件交回组织者。");
    ui.export.focus();
  }
}
function buildRecord(decisions, telemetry) {
  const item = row();
  const record = { review_schema_version: 2, blind_id: item.blind_id, reviewer_id: reviewer(),
    assignment_id: manifest().assignment_id, batch_id: manifest().batch_id, role: manifest().assignment_role,
    submission_state: "finalized", protocol_id: item.task_card.protocol_id, profile_id: item.task_card.profile_id,
    correspondence_id: item.assigned_correspondence_id ?? item.task_card.review_correspondence_id ??
      (item.task_card.allowed_correspondence_ids.length === 1 ? item.task_card.allowed_correspondence_ids[0] : null),
    evidence_status: effectiveAvailability(), material_issues: state.draft.issues, dimensions: decisions };
  for (const key of identityFields) record[key] = item[key];
  if (telemetry) record.interaction_metrics = telemetry;
  return record;
}
function finishTrial(record) {
  try { state.trialSession.finish(record); }
  catch (error) { notice(error.message, "error"); }
}
function finalize() {
  if (!row() || ui.workspace.getAttribute("aria-busy") === "true") return;
  if (!reviewer()) {
    ui.reviewer.focus();
    text(ui["completion-error"], "请选择分配给你的审阅编号。");
    return;
  }
  const decisions = decisionStates();
  const pending = Object.keys(decisions).find((key) => decisions[key].assessment_state === "pending");
  if (pending) {
    const label = labels[pending];
    const choice = state.draft.decisions[pending];
    const message = !choice?.verdict ? "请选择「" + label + "」的判断，或稍后再看。"
      : choice.verdict === "pass" ? "「" + label + "」有要求缺少可核验的证据。请重新判断。"
      : "请为「" + label + "」选择原因，明确反例请定位对应证据。";
    text(ui["completion-error"], message);
    fields[pending].fieldset.querySelector("input,button")?.focus();
    return;
  }
  const telemetry = metrics.snapshot() ?? state.draft.metrics;
  metrics.leave();
  const record = buildRecord(decisions, telemetry);
  state.draft.record = record;
  putDraft();
  refreshQueue();
  updateFormStates();
  if (state.trialSession) finishTrial(record);
  else continueReview();
}

ui["review-form"].addEventListener("submit", (event) => { event.preventDefault(); finalize(); });
ui["load-problem"].addEventListener("click", () => {
  player.pause();
  ui["problem-type"].value = "";
  ui["problem-note"].value = "";
  ui["problem-dialog"].showModal();
});
ui["problem-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  const code = ui["problem-type"].value;
  const note = ui["problem-note"].value.trim();
  ui["problem-dialog"].close();
  if (code === "reference_unobservable") {
    const key = assignedDimensions(row()).find((dimension) => dimension === "C") ?? assignedDimensions(row())[0];
    if (!key || fields[key].controls.hidden) return;
    chooseVerdict(key, "unknown");
    const choice = state.draft.decisions[key];
    if (note) choice.note = note;
    text(ui["completion-error"], "请点出哪项必要证据看不清。");
    fields[key].support.querySelector("button")?.focus();
    return;
  }
  const affected = code === "media_unavailable"
    ? channels.filter((key) => player.availability[key] === "unavailable") : issueChannels[code];
  if (!affected) return;
  const media = player.decoded.execution ?? player.videos.execution.currentTime;
  state.draft.issues.push({ code, affected_channels: affected, note,
    evidence: Number.isFinite(media) ? [{ kind: "report_location", time_basis: "execution_media",
      execution_video_pts_s: media, mapping_hash: row().time_mapping_hash }] : [] });
  metrics.add("problem_reports");
  if (code === "other_material_issue") metrics.add("no_option_count");
  state.draft.record = null;
  putDraft();
  updateFormStates();
  if (Object.values(decisionStates()).every((decision) => decision.assessment_state !== "pending")) finalize();
});
ui.later.addEventListener("click", () => {
  const next = nextPending(state.index);
  if (next >= 0) openCase(next);
  notice("本条已保留，可以稍后再看。");
});
ui.previous.addEventListener("click", () => openCase(state.index - 1));
ui.next.addEventListener("click", () => openCase(state.index + 1));
ui["retry-material"].addEventListener("click", () => openCase(state.index));
ui.filter.addEventListener("change", refreshQueue);
ui.reviewer.addEventListener("change", () => setReviewer(ui.reviewer.value));
ui.export.addEventListener("click", () => {
  if (!reviewer() || !manifest()) return;
  const records = cases().flatMap((entry) => {
    const record = state.bucket[entry.blind_id]?.[entry.case_fingerprint]?.record;
    return record?.reviewer_id === reviewer() && record.assignment_id === manifest().assignment_id &&
      identityFields.every((key) => record[key] === entry[key]) ? [JSON.stringify(record)] : [];
  });
  if (!records.length) return;
  const blob = new Blob([records.join("\n") + "\n"], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const link = create("a");
  link.href = url;
  link.download = manifest().assignment_id + "-" + reviewer() + ".jsonl";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  notice("已导出 " + records.length + " 条处理记录。");
});

const layoutKey = "ego-wm-review/v2/stacked";
function arrange(stacked) {
  ui.viewers.classList.toggle("is-stacked", stacked);
  text(ui["video-layout"], stacked ? "并排比较" : "上下排列");
  ui["video-layout"].setAttribute("aria-pressed", String(stacked));
}
arrange(read(layoutKey, false));
ui["video-layout"].addEventListener("click", () => {
  const stacked = !ui.viewers.classList.contains("is-stacked");
  arrange(stacked);
  write(layoutKey, stacked);
});
ui["help-toggle"].addEventListener("click", () => ui.help.showModal());
ui["open-default"].addEventListener("click", () => { ui.help.close(); openBatch(() => builtIn()); });
ui["import-zip"].addEventListener("click", () => ui["zip-file"].click());
ui["import-folder"].addEventListener("click", () => ui["folder-files"].click());
ui["zip-file"].addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (file) { ui.help.close(); openBatch(() => fromZip(file)); }
  event.target.value = "";
});
ui["folder-files"].addEventListener("change", (event) => {
  const files = [...event.target.files];
  if (files.length) { ui.help.close(); openBatch(() => fromFolder(files)); }
  event.target.value = "";
});
async function start() {
  try {
    state.trialSession = await loadTrialPage("v2");
    if (!state.trialSession) {
      await openBatch(() => builtIn());
      return;
    }
    ui.export.hidden = true;
    ui["open-default"].hidden = true;
    ui["import-zip"].hidden = ui["import-folder"].hidden = true;
    installTrialControls(state.trialSession, () => {
      if (!row() || !reviewer()) return;
      metrics.add("no_option_count");
      const record = buildRecord(decisionStates(), metrics.snapshot());
      record.submission_state = "needs_interface_exit";
      finishTrial(record);
    });
    await openBatch(() => state.trialSession.provider);
    ui["open-default"].hidden = true;
  } catch (error) {
    notice(error.message, "error");
    ui.workspace.setAttribute("aria-busy", "false");
  }
}
start();
