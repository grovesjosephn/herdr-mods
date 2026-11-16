// What the jade-changes panel shows, worked out from `jade status --json` and git's
// own output. No imports: the mod and its tests share it.

const trim = (p) => p.replace(/\/+$/, "");
export const inside = (path, dir) => Boolean(path && dir) && (trim(path) === trim(dir) || path.startsWith(trim(dir) + "/"));

/** Most files a group lists; the rest are counted, not drawn. */
export const FILE_LIMIT = 1000;

/** A file's id across apps: two apps can both change README.md. */
export const fileKey = (root, path) => `${root}//${path}`; // neither a clean root nor a git path holds "//"

/**
 * The workspace a `jade status --json` answer describes: its path, name and the
 * apps it holds a worktree of. null for a hub summary, older jade or anything else.
 */
export function readWorkspace(view) {
  if (!view || view.view !== "workspace" || !view.path) return null;
  const apps = (view.apps ?? []).filter((a) => a.present && a.path).map((a) => ({ name: a.name, root: a.path, branch: a.branch ?? null }));
  return { path: view.path, name: view.workspace ?? "", isMain: Boolean(view.isMain), apps };
}

/** `git diff --numstat -z` outputs, summed per path. */
export function readNumstat(outputs) {
  const stats = {};
  for (const out of outputs) {
    for (const entry of out.split("\0")) {
      const [a, d, ...parts] = entry.split("\t");
      if (!parts.length) continue;
      const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
      stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
    }
  }
  return stats;
}

/** `git status --porcelain=v1 -z --no-renames` as file rows (first FILE_LIMIT), with their line counts. */
export function readStatus(out, stats, root) {
  const entries = out.split("\0").filter(Boolean);
  const files = entries.slice(0, FILE_LIMIT).map((entry) => {
    const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
    const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
    const status = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
    return { key: fileKey(root, path), root, path, status, fresh, ...(stats[path] ?? { add: 0, del: 0 }) };
  });
  return { files, limited: entries.length > FILE_LIMIT };
}

export const countLines = (text) => (text ? text.split("\n").length - Number(text.endsWith("\n")) : 0);

// Text draws a tab as nothing: pad each to the next 4-column stop.
export const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd(s.length - 1 - ((s.length - 1) % 4) + 4));

/** Numbers each diff line once, so a frame only draws the rows on screen. */
export function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

/** Line totals across file rows. */
export const totals = (files) => files.reduce((t, f) => ({ add: t.add + f.add, del: t.del + f.del }), { add: 0, del: 0 });
