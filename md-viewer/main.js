import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, TextView, EditorState, Editor } from "gpui-base";
import { exec, run, theme, props, readTextFile, watchFolder, appHome, focused, shared } from "herdr";

const MOD = "mods/md-viewer";
// { [tab]: absolute path }: the files panel and md-open set this tab's entry to switch the reader.
const FOLLOW = "md.follow";
// Outside mods/: writes inside the mod folder trigger a hot reload.
const CACHE = "md-viewer-cache";

// iA Writer typefaces, one per kind of prose.
const BODY = "iA Writer Quattro S"; // running text: proportional, built for reading
const HEAD = "iA Writer Duo S";     // headings, tables: a little more voice
const MONO = "iA Writer Mono S";    // code, metadata

const dirname = (p) => p.replace(/\/[^/]*$/, "") || "/";
const HEADING = [0, 2.0, 1.55, 1.28, 1.1, 1.0, 0.9]; // × body size, by depth

export default class MdViewer extends View {
  init(p, cx) {
    // The tab this reader follows, given by whoever opened it (files panel, md-open). Without one it just shows `file`.
    this.tab = props()?.tab ?? p?.tab ?? null;
    this.followed = this.tab ? shared(FOLLOW)?.[this.tab] ?? null : null;
    this.file = this.followed ?? props()?.file ?? p?.file ?? null;
    this.gen = 0;
    this.blocks = [];
    this.editors = new Map();
    this.error = null;
    this.info = null;
    this.files = [];
    this.width = 700;
    this.fs = Number(localStorage.getItem("md.fs")) || 17;
    if (this.file) this.show(this.file, cx);
    else cx.spawn(async (cx) => { await this.listFiles(cx); });
  }

  // Load a file and live-reload it: re-render when it changes. A later show() ends this watch.
  show(file, cx) {
    this.file = file;
    const gen = ++this.gen;
    cx.spawn(async (cx) => {
      await this.load(cx);
      for (;;) {
        const changed = await watchFolder(dirname(file));
        if (gen !== this.gen) return;
        if (changed.some((c) => c === file || c.endsWith("/" + file.split("/").pop())))
          await this.load(cx);
      }
    });
  }

  // Another mod pointed this tab's reader at a new file.
  follow(cx) {
    const want = this.tab ? shared(FOLLOW)?.[this.tab] ?? null : null;
    if (!want || want === this.followed) return;
    this.followed = want;
    if (want !== this.file) this.show(want, cx);
  }

  async close() { this.releaseEditors(); }

  releaseEditors() {
    for (const s of this.editors.values()) s.release();
    this.editors.clear();
  }

  async listFiles(cx) {
    const cwd = focused()?.cwd ?? undefined;
    const r = await exec("find", [".", "-maxdepth", "3", "-name", "*.md", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"], { cwd });
    this.base = cwd;
    this.files = r.stdout.split("\n").filter(Boolean).sort().map((f) => f.replace(/^\.\//, ""));
    cx.notify();
  }

  async load(cx) {
    const file = this.file;
    const t = theme();
    const out = `${appHome()}/${CACHE}`;
    const themeJson = JSON.stringify(Object.fromEntries(Object.entries(t).filter(([, v]) => typeof v === "string")));
    let r;
    try { r = await exec("node", [`${appHome()}/${MOD}/render.mjs`, file, out, themeJson]); }
    catch (e) { if (file !== this.file) return; this.error = "exec failed: " + String(e?.message ?? e); cx.notify(); return; }
    try {
      const blocks = JSON.parse(await readTextFile(`${out}/${r.stdout.trim()}.json`));
      if (file !== this.file) return;
      this.releaseEditors();
      blocks.forEach((b, i) => {
        if (b.kind === "code") this.editors.set(i, this.makeEditor(b, t));
      });
      this.blocks = blocks;
      this.error = null;
      this.info = (() => { const n = blocks.filter((b) => b.kind.startsWith("mermaid")).length; return n ? `${n} diagram${n > 1 ? "s" : ""}` : null; })();
    } catch {
      if (file !== this.file) return;
      this.error = (r.stderr || r.stdout || "render failed").slice(0, 600);
    }
    cx.notify();
  }

  makeEditor(b, t) {
    return EditorState.new({
      language: b.lang || undefined, value: b.text, readonly: true,
      font_family: MONO, font_size: Math.round(this.fs * 0.82),
      line_numbers: false, folding: false, soft_wrap: false,
      syntax: {
        keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4,
        type: t.ansi3, number: t.ansi3, constant: t.ansi6, boolean: t.ansi3,
        variable: t.foreground, operator: t.muted, punctuation: t.muted,
      },
    });
  }

  setSize(fs, cx) {
    this.fs = Math.max(12, Math.min(28, fs));
    localStorage.setItem("md.fs", String(this.fs));
    const t = theme();
    this.releaseEditors();
    this.blocks.forEach((b, i) => { if (b.kind === "code") this.editors.set(i, this.makeEditor(b, t)); });
    cx.notify();
  }

  open(f, cx) {
    this.show(f.startsWith("/") ? f : `${this.base}/${f}`.replace(/\/\.\//g, "/"), cx);
  }

  renderPicker(t) {
    return v_flex().size_full().bg(t.background).p(16).gap(2).overflow_y_scrollbar().children([
      div().text_color(t.muted).text_size(12).font_family(BODY).pb(8).child("Markdown files in " + (this.base ?? "…")),
      ...this.files.map((f) => div().id("f-" + f).px(8).py(4).rounded(4).text_size(14).font_family(BODY).text_color(t.foreground)
        .hover((s) => s.bg(t.raised)).on_click((_e, cx) => this.open(f, cx)).child(f)),
    ]);
  }

  block(b, i, t, avail) {
    const fs = this.fs;
    const prose = (kind, raw) => TextView.markdown(`${kind}-${i}`, raw).selectable(true)
      .font_family(BODY).font_weight(400).text_size(fs).line_height(1.7).text_color(t.foreground);
    switch (b.kind) {
      case "heading": {
        const d = b.depth;
        return div().id("h-" + i).mt(Math.round(fs * (d <= 2 ? 1.9 : 1.4))).mb(Math.round(fs * 0.35))
          .when(b.center, (e) => e.text_center())
          .child(TextView.markdown(`h-${i}`, b.text).selectable(true)
            .font_family(HEAD).font_weight(700).text_size(Math.round(fs * HEADING[d]))
            .line_height(1.25).text_color(d >= 5 ? t.muted : t.foreground));
      }
      case "para": {
        const tv = prose("p", b.raw);
        return div().id("p-" + i).my(Math.round(fs * 0.45)).when(b.center, (e) => e.text_center()).child(b.center ? tv.text_center() : tv);
      }
      case "summary":
        return div().id("sm-" + i).mt(Math.round(fs * 0.9)).mb(Math.round(fs * 0.2)).font_family(HEAD).font_weight(700)
          .text_size(Math.round(fs * 0.95)).text_color(t.foreground).child("▾  ").child(
            TextView.markdown(`sm-${i}`, b.text).font_family(HEAD).font_weight(700).text_size(Math.round(fs * 0.95)).text_color(t.foreground));
      case "image":
      case "images": {
        const items = b.kind === "image" ? [b] : b.items;
        const one = items.length === 1;
        const pic = (m, k) => {
          if (m.kind !== "image") return div().id(`im-${i}-${k}`).text_size(12).text_color(t.dim).font_family(BODY).child(`[image: ${m.alt}]`);
          const w = Math.round(Math.min(m.pct ? avail * m.pct : m.px ? m.px : m.w, avail));
          return image(`${CACHE}/${m.name}`).id(`im-${i}-${k}`).w(w).h(Math.round(m.h * w / m.w)).rounded(one ? 6 : 3);
        };
        return div().id("ims-" + i).my(Math.round(fs * 0.6)).flex().flex_wrap().gap(6).items_center()
          .when(b.center, (e) => e.justify_center()).children(items.map(pic));
      }
      case "image-missing": return div().id("imm-" + i).text_size(12).text_color(t.dim).child(`[image: ${b.alt}]`);
      case "cols": {
        const gap = 18, n = b.cells.length, cw = Math.floor((avail - gap * (n - 1)) / n);
        return h_flex().id("cols-" + i).my(Math.round(fs * 0.5)).gap(gap).items_start().children(b.cells.map((c, k) =>
          v_flex().id(`cell-${i}-${k}`).flex_1().min_w(0).children(c.blocks.map((x, j) =>
            this.block(x.kind === "code" ? { kind: "para", raw: "```\n" + x.text + "\n```" } : x, `${i}-${k}-${j}`, t, cw)))));
      }
      case "list": return div().id("l-" + i).my(Math.round(fs * 0.45)).child(prose("l", b.raw));
      case "quote":
        return div().id("q-" + i).my(Math.round(fs * 0.7)).pl(Math.round(fs * 1.1))
          .border_l(3).border_color(t.accent)
          .child(prose("q", b.raw).italic().text_color(t.muted));
      case "table":
        return div().id("t-" + i).my(Math.round(fs * 0.7)).p(10).rounded(8).bg(t.surface).border(1).border_color(t.border)
          .child(TextView.markdown(`t-${i}`, b.raw).selectable(true)
            .font_family(HEAD).font_weight(400).text_size(Math.round(fs * 0.9)).line_height(1.5).text_color(t.foreground));
      case "code": {
        const st = this.editors.get(i);
        const lines = b.text.split("\n").length;
        const h = lines * Math.round(fs * 0.82 * 1.55) + 24;
        return div().id("c-" + i).my(Math.round(fs * 0.7)).rounded(8).bg(t.surface).border(1).border_color(t.border)
          .p(8).h(h).overflow_hidden().child(Editor.new(st));
      }
      case "hr": return div().id("hr-" + i).h(1).my(Math.round(fs * 1.6)).bg(t.border);
      case "meta":
        return div().id("m-" + i).mb(Math.round(fs * 0.8)).p(10).rounded(8).bg(t.surface)
          .font_family(MONO).text_size(Math.round(fs * 0.75)).text_color(t.dim).child(b.text);
      case "mermaid": {
        const w = Math.min(b.w * 1.15, avail);
        const h = Math.round(b.h * (w / b.w));
        return div().id("mm-" + i).my(Math.round(fs * 0.9)).py(14).flex().justify_center().rounded(8)
          .bg(t.surface).border(1).border_color(t.border)
          .child(image(`${CACHE}/${b.svg}`).w(Math.round(w)).h(h));
      }
      default:
        return v_flex().id("err-" + i).my(8).p(10).rounded(8).border(1).border_color(t.blocked).gap(6)
          .child(div().text_color(t.blocked).text_size(13).font_family(BODY).child("Mermaid error: " + b.error))
          .child(div().text_color(t.muted).text_size(12).font_family(MONO).child(b.src));
    }
  }

  render(cx) {
    this.follow(cx);
    const t = theme();
    if (!this.file) return this.renderPicker(t);
    const colW = Math.round(this.fs * 40); // ~66 characters per line
    const avail = Math.min(colW, Math.max(240, this.width - 56));
    const name = this.file.split("/").pop();
    const btn = (id, label, fn) => div().id(id).px(8).py(2).rounded(4).font_family(BODY).text_size(12)
      .text_color(t.muted).hover((s) => s.bg(t.raised).text_color(t.foreground)).on_click((_e, cx) => fn(cx)).child(label);
    const kids = this.blocks.map((b, i) => this.block(b, i, t, avail));
    if (this.error) kids.push(div().text_color(t.blocked).font_family(MONO).text_size(12).child(this.error));
    return v_flex().id("root").size_full().min_h(0).bg(t.background)
      .on_size_change((s, cx) => { if (Math.abs(s.width - this.width) > 1) { this.width = s.width; cx.notify(); } })
      .child(h_flex().px(14).py(4).gap(6).items_center().text_size(11).font_family(BODY).text_color(t.dim)
        .child(div().flex_1().truncate().child(`${name}${this.info ? "  ·  " + this.info : ""}`))
        .child(btn("open", "Open…", () => run("mod.open", { name: "md-open" })))
        .child(btn("fs-", "A−", (cx) => this.setSize(this.fs - 1, cx)))
        .child(btn("fs+", "A+", (cx) => this.setSize(this.fs + 1, cx))))
      .child(v_flex().id("scroll-" + this.file).flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().w_full().max_w(colW + 56).mx_auto().px(28).pt(8).pb(72).children(kids)));
  }
}
