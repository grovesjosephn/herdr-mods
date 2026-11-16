// Jade changes: uncommitted changes across every worktree of a jade workspace.
//
// The focused terminal's folder picks the workspace (`jade status --json` there);
// each app the workspace holds a worktree of is a group with its files, line
// counts and its own commit box. Outside a jade workspace (the hub root, another
// repo, a remote machine) it shows that folder's repo, like Changes.
//
// Props (optional): bin (the jade program; default shared "jade.bin", else "jade" on PATH).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, props, shared } from "herdr";
import { countLines, diffRows, readNumstat, readStatus, readWorkspace, totals } from "./model.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const where = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const bin = () => props()?.bin || shared("jade.bin") || "jade";
const HEADER = 30, ROW = 28, COMMIT = 44, NOTE = 22;

// The repos to list: the jade workspace's worktrees, else the folder's own repo. null: neither.
async function findScope({ cwd, on }) {
  if (!on) {
    // jade runs on this machine only.
    const r = await exec(bin(), ["status", "--json"], { cwd, timeout: 15000 }).catch(() => null);
    if (r?.code === 0) {
      let ws = null;
      try { ws = readWorkspace(JSON.parse(r.stdout)); } catch {}
      if (ws) return { id: `ws:${ws.path}`, name: ws.name, on: null, apps: ws.apps };
    }
  }
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
  if (top.code !== 0) return null;
  const root = top.stdout.trim();
  const branch = await exec("git", [...READ, "branch", "--show-current"], { cwd: root, on });
  return { id: `repo:${on ?? ""}:${root}`, name: null, on, apps: [{ name: root.split("/").pop(), root, branch: (branch.code === 0 && branch.stdout.trim()) || null }] };
}

// One app's changed files.
async function readGroup(app, on) {
  const git = (args) => exec("git", [...READ, ...args], { cwd: app.root, on });
  const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
  if (status.code !== 0) return { ...app, files: [], hasHead: false, error: status.stderr.trim() || "git status failed" };
  const head = await git(["rev-parse", "--verify", "HEAD"]);
  const results = head.code === 0
    ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])]
    : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
  const bad = results.find((r) => r.code !== 0);
  if (bad) return { ...app, files: [], hasHead: false, error: bad.stderr.trim() || "git diff failed" };
  const { files, limited } = readStatus(status.stdout, readNumstat(results.map((r) => r.stdout)), app.root);
  return { ...app, files, limited, hasHead: head.code === 0, error: null };
}

export default class JadeChanges extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.watchGen = 0;
    this.reset(null);
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  // A new workspace or repo: nothing from the old one carries over.
  reset(scope) {
    this.scope = scope; this.groups = []; this.open = null; this.closed = false; this.error = null; this.note = null;
    this.commits = new Map(); // app root -> its commit box
    this.watchGen++; this.watched = new Set();
    this.setLines([]);
  }

  files() { return this.groups.flatMap((g) => g.files); }
  committing() { return [...this.commits.values()].some((c) => c.busy); }

  watch(root, cx) {
    if (this.watched.has(root)) return;
    this.watched.add(root);
    const gen = this.watchGen;
    cx.spawn(async (cx) => {
      try {
        while (gen === this.watchGen) {
          await watchFolder(root);
          if (gen === this.watchGen) this.refresh(cx);
        }
      } catch { if (gen === this.watchGen) this.watched.delete(root); }
    });
  }

  refresh(cx) {
    if (this.loading || this.committing()) { this.again = true; return; }
    const loc = location(), context = where();
    this.context = context; this.again = false;
    if (!loc.cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const scope = await findScope(loc);
        if (where() !== context) return;
        if (!scope) { this.reset(null); this.error = "Not in a jade workspace or git repository"; return; }
        if (scope.id !== this.scope?.id) this.reset(scope);
        const groups = await Promise.all(scope.apps.map((app) => readGroup(app, scope.on).catch((e) => ({ ...app, files: [], error: String(e) }))));
        if (this.scope?.id !== scope.id) return;
        this.scope = scope; this.groups = groups; this.error = null;
        for (const g of groups) {
          this.commitBox(g.root);
          if (!scope.on) this.watch(g.root, cx);
        }
        const files = this.files();
        if (this.open && !files.some((f) => f.key === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].key;
        if (this.open) {
          try { await this.load(this.open, scope.id); }
          catch { if (this.scope?.id === scope.id) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (where() === context) this.error = String(e); }
      finally {
        this.loading = false;
        if (this.again) this.refresh(cx);
        cx.notify();
      }
    });
  }

  async load(key, scopeId) {
    const file = this.files().find((f) => f.key === key), group = this.groups.find((g) => g.root === file?.root), on = this.scope?.on ?? null;
    if (!file || !group) return;
    let lines;
    if (file.fresh || (!group.hasHead && file.status === "A")) {
      const text = await readTextFile(`${file.root}/${file.path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map((l) => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(group.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", file.path], { cwd: file.root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (this.scope?.id === scopeId && this.open === key) this.setLines(lines.slice(0, 1500).map((line) => (line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line)));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...this.rows.map((row) => (row.text.length + 1) * 7 + 50));
  }

  pick(key, cx) {
    this.open = this.open === key ? null : key; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const scopeId = this.scope?.id;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(key, scopeId); }
      catch (e) { if (this.scope?.id === scopeId && this.open === key) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  // An app's commit box, made once so its text and focus survive refreshes.
  commitBox(root) {
    let box = this.commits.get(root);
    if (box) return box;
    const input = InputState.new({ placeholder: "Commit message" });
    box = { input, message: "", typing: false, busy: false, note: null };
    input.on("change", (_e, cx) => {
      const had = Boolean(box.message.trim());
      box.message = input.value();
      if (had !== Boolean(box.message.trim())) cx.notify();
    });
    input.on("submit", (_e, cx) => this.commit(root, cx));
    input.on("focus", (_e, cx) => { box.typing = true; cx.notify(); });
    input.on("blur", (_e, cx) => { box.typing = false; cx.notify(); });
    this.commits.set(root, box);
    return box;
  }

  commit(root, cx) {
    const box = this.commits.get(root), scope = this.scope;
    if (!box || !scope || !box.message.trim() || box.busy || this.loading) return;
    const message = box.message.trim();
    box.busy = true; box.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on: scope.on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        box.message = ""; box.input.set_value("");
      } catch (e) { box.note = `Commit failed: ${e.message ?? e}`; }
      finally { box.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  counts(add, del, t) {
    return h_flex().gap(6).flex_none()
      .when(add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)))
      .when(del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)));
  }

  fileRow(f, t) {
    const parts = f.path.split("/"), name = parts.pop();
    return h_flex().id(`change-${f.key}`).h(ROW).flex_none().pl(18).pr(8).gap(8).items_center().rounded(7).cursor_pointer()
      .when(this.open === f.key, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.key, cx))
      .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" || f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
      .child(this.counts(f.add, f.del, t));
  }

  commitRow(g, t) {
    const box = this.commitBox(g.root), enabled = Boolean(box.message.trim() && !box.busy && !this.loading);
    return h_flex().id(`commit-row-${g.root}`).h(COMMIT).flex_none().pl(18).pr(2).py(6).gap(8).items_center()
      .child(div().id(`commit-message-${g.root}`).flex_1().min_w(0).h(30).px(10).flex().items_center().rounded(8).border_1().border_color(box.typing ? t.accent : t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(box.input).h_full().text_size(12).text_color(t.foreground)))
      .child(div().id(`commit-${g.root}`).h(30).px(12).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12)
        .when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(g.root, cx)).child(box.busy ? "Committing…" : "Commit"));
  }

  group(g, t) {
    const { add, del } = totals(g.files), box = this.commits.get(g.root), clean = !g.files.length && !g.error;
    return v_flex().flex_none()
      .child(h_flex().h(HEADER).flex_none().px(8).gap(8).items_center()
        .child(div().font_semibold().flex_none().when(clean, (e) => e.text_color(t.muted)).child(g.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(g.branch ?? "detached"))
        .child(clean ? div().text_size(11).text_color(t.dim).child("clean") : this.counts(add, del, t))
        .when(g.files.length > 0, (e) => e.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(String(g.files.length)))))
      .when(Boolean(g.error), (e) => e.child(div().h(NOTE).pl(18).text_size(11).text_color(t.ansi1).truncate().child(g.error)))
      .children(g.files.map((f) => this.fileRow(f, t)))
      .when(Boolean(g.limited), (e) => e.child(div().h(NOTE).pl(18).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .when(g.files.length > 0, (e) => e.child(this.commitRow(g, t)))
      .when(Boolean(box?.note), (e) => e.child(div().h(NOTE).pl(18).text_size(11).text_color(t.ansi1).truncate().child(box.note)));
  }

  listHeight() {
    return this.groups.reduce((h, g) => h + HEADER + g.files.length * ROW + (g.files.length ? COMMIT : 0)
      + (g.error ? NOTE : 0) + (g.limited ? NOTE : 0) + (this.commits.get(g.root)?.note ? NOTE : 0), 12);
  }

  render(cx) {
    if (where() !== this.context) this.refresh(cx);
    const t = theme(), files = this.files(), { add, del } = totals(files);
    const openFile = this.open ? files.find((f) => f.key === this.open) : null;
    const openApp = openFile && this.groups.length > 1 ? this.groups.find((g) => g.root === openFile.root)?.name : null;
    const empty = this.error || (this.loading ? "Loading changes…" : this.scope ? "" : "No folder");
    return v_flex().id("jade-changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        const box = [...this.commits.values()].find((b) => b.typing);
        if (box) { box.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .when(Boolean(this.scope?.name), (e) => e.child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(this.scope.name)))
        .child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${files.length} files`))
        .child(div().flex_1()).child(this.counts(add, del, t)))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(44).max_h(this.groups.length ? this.listHeight() : 44).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("jade-changes-list").absolute().inset_0().overflow_y_scroll().p(6)
          .children(this.groups.map((g) => this.group(g, t)))
          .when(!this.groups.length, (e) => e.child(div().p(8).text_color(t.dim).child(empty))))
        .child(Scrollbar.vertical("jade-changes-list").absolute().inset_0()))
      .when(Boolean(openApp), (e) => e.child(h_flex().h(24).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border).text_size(11)
        .child(div().text_color(t.muted).flex_none().child(openApp)).child(div().min_w(0).truncate().text_color(t.dim).child(openFile.path))))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("jade-changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("jade-changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("jade-changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes")))
        .when(!files.length && this.groups.length > 0 && !this.loading, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("No uncommitted changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)));
  }
}
