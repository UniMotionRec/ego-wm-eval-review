const blank = () => ({
  elapsed_s: 0, click_count: 0, typed_chars: 0, problem_reports: 0, no_option_count: 0, verdict_revisions: 0,
});

export class ReviewMetrics {
  constructor(version, onChange) {
    this.version = version;
    this.onChange = onChange;
    this.previousTexts = new WeakMap();
    document.addEventListener("click", (event) => {
      if (event.isTrusted && event.detail > 0 && event.target.closest("#workspace, #problem-dialog, #case-list"))
        this.add("click_count");
    }, true);
    document.addEventListener("focusin", (event) => {
      if (event.target.matches("textarea, input[type=text]")) this.previousTexts.set(event.target, event.target.value);
    });
    document.addEventListener("input", (event) => {
      const control = event.target;
      if (!event.isTrusted || !control.matches("#workspace textarea, #workspace input[type=text], #problem-dialog textarea")) return;
      const prior = this.previousTexts.get(control) ?? "";
      const typed = event.inputType?.startsWith("insert") && event.data ?
        [...event.data].length : Math.max(0, [...control.value].length - [...prior].length);
      this.previousTexts.set(control, control.value);
      if (typed) this.add("typed_chars", typed);
    }, true);
    document.addEventListener("visibilitychange", () => this.refreshClock());
    window.addEventListener("pagehide", () => this.leave());
  }
  start(snapshot, index, enabled) {
    this.leave();
    if (!enabled) return;
    this.data = { ...blank(), ...snapshot, interface_version: this.version, sequence_index: index };
    this.started = document.hidden ? null : performance.now();
  }
  refreshClock() {
    if (!this.data) return;
    const now = performance.now();
    if (this.started != null) this.data.elapsed_s += (now - this.started) / 1000;
    this.started = document.hidden ? null : now;
    this.onChange(this.snapshot());
  }
  snapshot() {
    if (!this.data) return undefined;
    const current = this.started == null ? 0 : (performance.now() - this.started) / 1000;
    return { ...this.data, elapsed_s: Math.round((this.data.elapsed_s + current) * 1000) / 1000 };
  }
  leave() {
    if (!this.data) return;
    this.onChange(this.snapshot());
    this.data = null;
    this.started = null;
  }
  add(key, increment = 1) {
    if (!this.data) return;
    this.data[key] += increment;
    this.onChange(this.snapshot());
  }
}

export function addTrialMarker(metrics, enabled) {
  let button = document.getElementById("trial-marker");
  if (!button && enabled) {
    button = document.createElement("button");
    button.type = "button";
    button.id = "trial-marker";
    button.className = "link-button";
    button.textContent = "选项不合适";
    button.addEventListener("click", () => {
      metrics.add("no_option_count");
      button.textContent = "已记录这次选项问题";
    });
    document.querySelector(".form-footer").prepend(button);
  }
  if (button) {
    button.hidden = !enabled;
    button.textContent = "选项不合适";
  }
}
