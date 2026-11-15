import { fromZip } from "./bundle.js";

const slotKey = (reviewer) => "ego-wm-review/a1/20261115/" + reviewer;
const reviewers = ["R1", "R2"];
const urlParams = new URLSearchParams(location.search);

function load(reviewer) {
  try { return JSON.parse(localStorage.getItem(slotKey(reviewer))) ?? {}; }
  catch { return {}; }
}

async function schedule(reviewer) {
  if (!reviewers.includes(reviewer)) throw new Error("请选择分配给你的审阅编号。");
  const path = "./a1/" + reviewer + "-order.json";
  const response = await fetch(path);
  if (!response.ok) throw new Error("试验顺序暂时无法读取。");
  const rows = await response.json();
  if (rows.length !== 16 || rows.some((row, index) => row.trial_position !== index ||
    !["v1", "v2"].includes(row.interface))) throw new Error("试验顺序与登记不符。");
  return rows;
}

function stepUrl(reviewer, step) {
  const file = step.interface === "v1" ? "legacy.html" : "index.html";
  return "./" + file + "?a1=" + reviewer + "&position=" + step.trial_position;
}

function nextStep(rows, saved, index) {
  return rows.find((step) => step.trial_position > index && !saved[step.trial_position]) ??
    rows.find((step) => !saved[step.trial_position]);
}

export async function loadTrialPage(expected) {
  const reviewer = urlParams.get("a1");
  if (!reviewer) return null;
  const rows = await schedule(reviewer);
  const position = Number(urlParams.get("position"));
  const step = rows[position];
  if (!step || step.interface !== expected)
    throw new Error("链接对应另一页，回到试验入口即可继续。");
  const response = await fetch("./a1/" + reviewer + "-" + expected + ".zip");
  if (!response.ok) throw new Error("该组素材暂时无法读取。");
  const provider = await fromZip(await response.blob());
  const original = provider.manifest;
  const entry = original.cases.find((candidate) => candidate.trial_position === position && candidate.blind_id === step.blind_id);
  if (!entry || original.assignment_id !== step.assignment_id || original.trial_reviewer_id !== reviewer ||
    original.usability_trial !== true) throw new Error("素材与本次试验指派不符。");
  const manifest = { ...original, cases: [entry] };
  function finish(record) {
    if (record.reviewer_id !== reviewer || record.blind_id !== step.blind_id ||
      record.assignment_id !== step.assignment_id || record.interaction_metrics?.sequence_index !== position) {
      throw new Error("记录与试验顺序不符。");
    }
    const saved = load(reviewer);
    saved[position] = record;
    localStorage.setItem(slotKey(reviewer), JSON.stringify(saved));
    const next = nextStep(rows, saved, position);
    const destination = next ? stepUrl(reviewer, next) : "./a1.html?reviewer=" + reviewer;
    location.assign(destination);
  }
  return { provider: { ...provider, manifest }, reviewer, position, total: rows.length, finish };
}

export function installTrialControls(context, exit) {
  const navigation = document.createElement("a");
  navigation.className = "link-button";
  navigation.textContent = "返回试验进度";
  navigation.href = "./a1.html?reviewer=" + context.reviewer;
  document.querySelector(".mast-actions").append(navigation);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "link-button";
  button.textContent = "当前无法提交，记录后继续";
  button.addEventListener("click", exit);
  document.querySelector(".form-footer").prepend(button);
}

function landing() {
  const identity = document.getElementById("trial-reviewer");
  if (!identity) return;
  const initial = urlParams.get("reviewer");
  if (reviewers.includes(initial)) identity.value = initial;
  const info = document.getElementById("trial-progress");
  const begin = document.getElementById("trial-start");
  const download = document.getElementById("trial-export");
  const refresh = () => {
    const reviewer = identity.value;
    const count = reviewers.includes(reviewer) ? Object.keys(load(reviewer)).length : 0;
    info.textContent = "已处理 " + count + " / 16 条";
    begin.disabled = !reviewers.includes(reviewer) || count >= 16;
    begin.textContent = count ? "继续审阅" : "开始审阅";
    download.disabled = count === 0;
  };
  identity.addEventListener("change", refresh);
  begin.addEventListener("click", async () => {
    try {
      const reviewer = identity.value;
      const rows = await schedule(reviewer);
      const candidate = nextStep(rows, load(reviewer), -1);
      if (candidate) location.assign(stepUrl(reviewer, candidate));
    } catch (error) { info.textContent = error.message; }
  });
  download.addEventListener("click", () => {
    const reviewer = identity.value;
    const items = Object.entries(load(reviewer)).sort(([a], [b]) => Number(a) - Number(b));
    if (!items.length) return;
    const blob = new Blob([items.map(([, record]) => JSON.stringify(record)).join("\n") + "\n"],
      { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const save = document.createElement("a");
    save.href = url;
    save.download = "ego-wm-a1-" + reviewer + ".jsonl";
    save.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
  refresh();
}
landing();
