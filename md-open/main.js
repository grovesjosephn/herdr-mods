// Open a markdown file in the md-viewer: fuzzy-filter the project's .md files,
// or type a path. Enter shows it in this tab's reader (opening one beside the focused pane), Shift+Enter in a new tab,
// Esc leaves. Recently opened files come first.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, run, theme, props, closeOverlay, focused, shared, setShared, home, panes } from "herdr";

// Which file each tab's reader shows: { [tab]: absolute path }. md-viewer follows it.
// "md.readers" { [tab]: true } marks tabs whose md-viewer was opened to follow (older ones don't).
const FOLLOW = "md.follow", READERS = "md.readers";
const liveTabs = () => new Set(panes().map(p => p.tab));
const prune = (m) => { const live = liveTabs(); return Object.fromEntries(Object.entries(m ?? {}).filter(([t]) => live.has(t))); };

// Show a markdown file in this tab's reader pane, opening one on the right if there is none.
// Returns the reader's pane when one already existed.
function openInReader(abs, f) {
  const tab = f?.tab;
  if (!tab) return null;
  setShared(FOLLOW, { ...prune(shared(FOLLOW)), [tab]: abs });
  const reader = shared(READERS)?.[tab] ? panes().find(p => p.tab === tab && p.mod === "md-viewer") : null;
  if (reader) return reader.pane;
  setShared(READERS, { ...prune(shared(READERS)), [tab]: true });
  const here = panes().filter(p => p.tab === tab);
  const anchor = here.find(p => p.pane === f.pane && !p.mod) ?? here.find(p => p.terminal) ?? here[0];
  run("pane.split", { direction: "right", ...(anchor ? { pane: anchor.pane } : {}), mod: "md-viewer", props: { file: abs, tab } });
  return null;
}

const ROWS = 9, ROW_H = 34;
const base = (p) => p.split("/").pop();
const dir = (p) => p.slice(0, Math.max(0, p.length - base(p).length - 1));

// Subsequence match; null when the query doesn't fit. Higher is better.
function score(q, path) {
  const s = path.toLowerCase(), name = base(s);
  let i = 0, sc = 0, run_ = 0;
  for (const ch of q) {
    const j = s.indexOf(ch, i);
    if (j < 0) return null;
    run_ = j === i ? run_ + 1 : 0;
    sc += 1 + run_ * 2 + (j >= s.length - name.length ? 2 : 0);
    i = j + 1;
  }
  if (name.includes(q)) sc += 40;
  return sc - s.length * 0.05;
}

export default class MdOpen extends View {
  init(_props, cx) {
    // Snapshot first: this is where the file will open.
    this.from = focused();
    this.root = this.from?.cwd ?? home();
    this.files = [];
    this.filter = "";
    this.at = 0;
    this.loading = true;
    this.input = InputState.new({ placeholder: "Open a markdown file…  (or type a path)" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", () => this.open(this.rows()[this.at], false));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => { await this.scan(); this.loading = false; cx.notify(); });
  }

  async scan() {
    const cwd = this.root;
    let top = cwd;
    try {
      const g = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
      if (g.code === 0 && g.stdout.trim()) top = g.stdout.trim();
    } catch {}
    this.top = top;
    let out = "";
    try {
      const r = await exec("git", ["ls-files", "-co", "--exclude-standard", "--", "*.md", "*.markdown"], { cwd: top });
      if (r.code === 0) out = r.stdout;
    } catch {}
    if (!out.trim()) {
      const r = await exec("find", [".", "-maxdepth", "5", "(", "-name", "*.md", "-o", "-name", "*.markdown", ")",
        "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"], { cwd: top });
      out = r.stdout.replace(/^\.\//gm, "");
    }
    this.files = out.split("\n").filter(Boolean).map((rel) => ({ rel, abs: `${top}/${rel}` }));
    this.nHere = this.files.length;
    // Widen: other projects under ~/Projects (and ~/Documents, ~/notes), listed after this project's files.
    const h = home();
    const seen = new Set(this.files.map((f) => f.abs));
    try {
      const r = await exec("find", [`${h}/Projects`, `${h}/Documents`, `${h}/notes`, "-maxdepth", "5", "-type", "f",
        "(", "-name", "*.md", "-o", "-name", "*.markdown", ")",
        "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*", "-not", "-path", "*/target/*", "-not", "-path", "*/.cache/*"], { cwd: h });
      for (const abs of r.stdout.split("\n").filter(Boolean)) {
        if (seen.has(abs)) continue;
        seen.add(abs);
        this.files.push({ rel: abs.startsWith(h + "/") ? "~/" + abs.slice(h.length + 1) : abs, abs });
      }
    } catch {}
  }

  rows() {
    const f = this.filter.trim();
    if (f.startsWith("/") || f.startsWith("~")) {
      const abs = f.startsWith("~") ? home() + f.slice(1) : f;
      return [{ abs, rel: abs, typed: true }];
    }
    const recent = (shared("md.recent") ?? []).map((abs) => ({ abs, rel: abs.startsWith(this.top + "/") ? abs.slice(this.top.length + 1) : abs, recent: true }));
    if (!f) {
      const seen = new Set(recent.map((r) => r.abs));
      return [...recent, ...this.files.filter((x) => !seen.has(x.abs))];
    }
    const q = f.toLowerCase();
    const pool = [...recent, ...this.files.filter((x) => !recent.some((r) => r.abs === x.abs))];
    return pool.map((r) => ({ r, s: score(q, r.rel) })).filter((x) => x.s !== null)
      .sort((a, b) => b.s - a.s).map((x) => x.r);
  }

  open(r, inTab) {
    if (!r) return;
    setShared("md.recent", [r.abs, ...(shared("md.recent") ?? []).filter((p) => p !== r.abs)].slice(0, 8));
    closeOverlay(props().overlay);
    if (inTab || !this.from?.tab) { run("tab.new", { name: base(r.abs), mod: "md-viewer", props: { file: r.abs } }); return; }
    const reader = openInReader(r.abs, this.from);
    if (reader) run("pane.focus", { pane: reader });
  }

  render() {
    const t = theme();
    const rows = this.rows();
    this.at = Math.max(0, Math.min(this.at, rows.length - 1));
    const start = Math.max(0, Math.min(this.at - 4, rows.length - ROWS));
    const shown = rows.slice(start, start + ROWS);

    const row = (r, i) => {
      const sel = start + i === this.at;
      return h_flex().id("mo-" + r.abs).h(ROW_H).px(10).gap(8).items_center().rounded(7)
        .bg(sel ? t.selected : "#00000000").cursor_pointer()
        .hover((s) => s.bg(sel ? t.selected : t.hover))
        .on_click(() => this.open(r, false))
        .child(div().w(14).flex_none().text_size(11).text_color(t.dim).child(r.recent ? "↺" : "·"))
        .child(div().text_size(13).text_color(t.foreground).flex_none().child(base(r.rel)))
        .child(div().flex_1().truncate().text_size(11.5).text_color(t.dim).child(dir(r.rel)));
    };

    return v_flex().id("md-open").track_focus(this.handle).w_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return closeOverlay(props().overlay);
        if (k === "down") this.at = (this.at + 1) % Math.max(1, rows.length);
        else if (k === "up") this.at = (this.at + rows.length - 1) % Math.max(1, rows.length);
        else if (k === "enter" && e.modifiers.shift) { this.open(rows[this.at], true); cx.stop_propagation(); return; }
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Open markdown"))
        .child(div().text_size(11).text_color(t.dim).child("↵ beside  ·  ⇧↵ new tab  ·  Esc")))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/workspace-chrome/search.svg").size(15).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .child(v_flex().id("mo-list").h(ROWS * ROW_H).min_h(0).overflow_hidden()
        .on_scroll_wheel((e, cx) => {
          this.at = Math.max(0, Math.min(this.at + (e.delta.y < 0 ? 1 : -1), rows.length - 1));
          cx.notify();
        })
        .children(shown.map(row))
        .when(!rows.length, (el) => el.child(div().p(12).text_color(t.dim).text_size(12.5)
          .child(this.loading ? "Looking for markdown files…" : `No markdown files match in ${this.top ?? this.root}`))))
      .child(div().text_size(11).text_color(t.dim).truncate().child(this.top ? `Searching ${this.top}` : ""));
  }
}
