// usage: node render.mjs <file.md> <outDir> '<themeJson>'
// Prints JSON: [{kind:"md",text}|{kind:"mermaid",svg:"<file>",w,h}|{kind:"mermaid-error",src,error}]
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseHtml, HTMLElement, TextNode } from "node-html-parser";
import { render } from "pele";
import { Lexer } from "marked";

const [file, outDir, themeJson] = process.argv.slice(2);
const t = JSON.parse(themeJson || "{}");
const map = {
  bg: t.background, fg: t.foreground, muted: t.muted, line: t.muted,
  surface: t.surface, "surface-alt": t.raised, border: t.border, accent: t.accent,
  font: "'iA Writer Quattro S', sans-serif", "font-mono": "'iA Writer Mono S', monospace",
  "series-1": t.ansi4, "series-2": t.ansi2, "series-3": t.ansi3, "series-4": t.ansi1,
  "series-5": t.ansi5, "series-6": t.ansi6, "series-7": t.ansi9, "series-8": t.ansi10,
};

// resvg-style renderers don't do CSS var(): resolve them.
function resolveVars(svg) {
  const defs = {};
  svg = svg.replace(/style="([^"]*)"/, (m, s) => {
    const kept = [];
    for (const d of s.split(";")) {
      const mm = d.match(/^\s*(--_[a-z]+):(.*)$/);
      if (mm) defs[mm[1]] = mm[2].trim(); else kept.push(d);
    }
    return `style="${kept.join(";")}"`;
  });
  const sub = (s) => s.replace(/var\(--pele-([a-z0-9-]+)(?:,\s*([^)]*))?\)/g,
    (_, k, fb) => map[k] ?? fb ?? "currentColor");
  for (const k in defs) defs[k] = sub(defs[k]);
  const fg = map.fg ?? "#ddd";
  svg = sub(svg).replace(/var\((--_[a-z]+)\)/g, (_, k) => defs[k] ?? "currentColor");
  return svg.replace(/currentColor/g, fg).replace(/color:[^;"]*;?/, "");
}

let md = readFileSync(file, "utf8");
mkdirSync(outDir, { recursive: true });
const out = [];

// YAML front matter -> a quiet metadata block
const fm = md.match(/^---\n([\s\S]*?)\n---\n?/);
if (fm) { out.push({ kind: "meta", text: fm[1] }); md = md.slice(fm[0].length); }

function diagram(src) {
  try {
    const { svg } = render(src);
    const final = resolveVars(svg);
    const name = createHash("sha1").update(final).digest("hex").slice(0, 12) + ".svg";
    if (!existsSync(`${outDir}/${name}`)) writeFileSync(`${outDir}/${name}`, final);
    const vb = final.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    return { kind: "mermaid", svg: name, w: +vb?.[1] || 400, h: +vb?.[2] || 300 };
  } catch (e) {
    return { kind: "mermaid-error", src, error: String(e.message ?? e) };
  }
}

// ---- images ------------------------------------------------------------
// Everything the viewer draws must live in outDir (image() paths are relative to the app home).
const sha = (x) => createHash("sha1").update(x).digest("hex").slice(0, 12);
const dimsOf = (p) => {
  try {
    const [w, h] = execFileSync("magick", ["identify", "-format", "%w %h", p + "[0]"], { encoding: "utf8", timeout: 8000 }).trim().split(" ").map(Number);
    return w && h ? { w, h } : null;
  } catch { return null; }
};
const svgDims = (txt) => {
  const w = txt.match(/<svg[^>]*\swidth="([\d.]+)/), h = txt.match(/<svg[^>]*\sheight="([\d.]+)/);
  if (w && h) return { w: +w[1], h: +h[1] };
  const vb = txt.match(/viewBox="[\d.\s-]*?([\d.]+)\s+([\d.]+)"/);
  return vb ? { w: +vb[1], h: +vb[2] } : { w: 120, h: 20 };
};
async function asset(src) {
  src = src.trim();
  try {
    let local, ext;
    if (/^https?:/i.test(src)) {
      const key = sha(src);
      const hit = ["png", "svg"].map((e) => `${key}.${e}`).find((n) => existsSync(`${outDir}/${n}`));
      if (hit) return hit.endsWith(".svg") ? { name: hit, ...svgDims(readFileSync(`${outDir}/${hit}`, "utf8")) } : { name: hit, ...dimsOf(`${outDir}/${hit}`) };
      const res = await fetch(src, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const isSvg = /svg/.test(res.headers.get("content-type") ?? "") || buf.subarray(0, 300).toString().includes("<svg");
      if (isSvg) { const txt = buf.toString("utf8"); writeFileSync(`${outDir}/${key}.svg`, txt); return { name: `${key}.svg`, ...svgDims(txt) }; }
      writeFileSync(`${outDir}/${key}.raw`, buf);
      local = `${outDir}/${key}.raw`; ext = ".raw";
      const out = `${outDir}/${key}.png`;
      execFileSync("magick", [local + "[-1]", "-resize", "1800x>", out], { timeout: 15000 });
      return { name: `${key}.png`, ...dimsOf(out) };
    }
    local = resolve(dirname(file), decodeURI(src.split(/[?#]/)[0]));
    if (!existsSync(local)) return null;
    const st = statSync(local), key = sha(local + st.mtimeMs + st.size);
    if (extname(local).toLowerCase() === ".svg") {
      const txt = readFileSync(local, "utf8"), name = `${key}.svg`;
      if (!existsSync(`${outDir}/${name}`)) writeFileSync(`${outDir}/${name}`, txt);
      return { name, ...svgDims(txt) };
    }
    const name = `${key}.png`;
    if (!existsSync(`${outDir}/${name}`)) execFileSync("magick", [local + "[-1]", "-resize", "1800x>", `${outDir}/${name}`], { timeout: 15000 });
    return { name, ...dimsOf(`${outDir}/${name}`) };
  } catch { return null; }
}
async function imageBlock(src, alt, extra = {}) {
  const a = src ? await asset(src) : null;
  return a?.w ? { kind: "image", name: a.name, w: a.w, h: a.h, alt, ...extra } : { kind: "image-missing", alt: alt || src, ...extra };
}

// ---- HTML -> blocks ------------------------------------------------------
const esc = (s) => s.replace(/([\\`*_{}\[\]<>|])/g, "\\$1");
function inline(node) {                      // inline HTML -> markdown text
  if (node instanceof TextNode) return esc(node.text.replace(/\s+/g, " "));
  if (!(node instanceof HTMLElement)) return "";
  const k = node.rawTagName?.toLowerCase(), inner = () => node.childNodes.map(inline).join("");
  switch (k) {
    case "b": case "strong": return `**${inner().trim()}**`;
    case "i": case "em": return `*${inner().trim()}*`;
    case "code": return "`" + node.text + "`";
    case "br": return "  \n";
    case "a": { const h = node.getAttribute("href"); return h ? `[${inner()}](${h})` : inner(); }
    case "sub": case "sup": case "small": case "span": case "kbd": case "u": return inner();
    default: return inner();
  }
}
const BLOCK = new Set(["div", "p", "table", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "pre", "blockquote", "details", "center", "section"]);
const centered = (n, c) => c || n.getAttribute?.("align") === "center" || n.rawTagName === "center";

async function htmlBlocks(nodes, center = false, sink = []) {
  let buf = "", imgs = [];
  const flushImgs = () => { if (imgs.length) { sink.push({ kind: "images", items: imgs, center }); imgs = []; } };
  const flushText = () => { flushImgs(); if (buf.trim()) sink.push({ kind: "para", raw: buf.trim(), center }); buf = ""; };
  for (const n of nodes) {
    if (n instanceof TextNode) { if (n.text.trim()) { flushImgs(); buf += esc(n.text.replace(/\s+/g, " ")); } continue; }
    if (!(n instanceof HTMLElement)) continue;
    const k = n.rawTagName?.toLowerCase();
    // an <img>, or <a><img></a>, collects into a row of images
    const img = k === "img" ? n : (k === "a" && n.querySelectorAll("img").length === 1 && !n.text.trim() ? n.querySelector("img") : null);
    if (img) {
      if (buf.trim()) { sink.push({ kind: "para", raw: buf.trim(), center }); buf = ""; }
      const wa = img.getAttribute("width") ?? "", pct = /%$/.test(wa) ? parseFloat(wa) / 100 : null;
      imgs.push(await imageBlock(img.getAttribute("src"), img.getAttribute("alt") ?? "", { pct, px: pct == null && /^\d+$/.test(wa) ? +wa : null }));
      continue;
    }
    if (!BLOCK.has(k)) { flushImgs(); buf += inline(n); continue; }
    flushText();
    const c = centered(n, center);
    if (/^h[1-6]$/.test(k)) sink.push({ kind: "heading", depth: +k[1], text: n.childNodes.map(inline).join("").trim(), center: c });
    else if (k === "hr") sink.push({ kind: "hr" });
    else if (k === "pre") sink.push({ kind: "code", lang: "", text: n.text.replace(/^\n|\n$/g, "") });
    else if (k === "ul" || k === "ol") {
      const items = n.childNodes.filter((x) => x.rawTagName?.toLowerCase() === "li").map((li, i) => `${k === "ol" ? i + 1 + "." : "-"} ${li.childNodes.map(inline).join("").trim()}`);
      sink.push({ kind: "list", raw: items.join("\n") });
    } else if (k === "blockquote") sink.push({ kind: "quote", raw: n.childNodes.map(inline).join("").trim() });
    else if (k === "table") {
      for (const tr of n.querySelectorAll("tr")) {
        const cells = [];
        for (const td of tr.childNodes.filter((x) => /^t[dh]$/.test(x.rawTagName?.toLowerCase() ?? ""))) {
          const wa = td.getAttribute("width") ?? "";
          cells.push({ w: /%$/.test(wa) ? parseFloat(wa) : null, blocks: await htmlBlocks(td.childNodes, centered(td, false)) });
        }
        if (cells.length) sink.push({ kind: "cols", cells });
      }
    } else if (k === "details") {
      const sm = n.querySelector("summary");
      if (sm) sink.push({ kind: "summary", text: sm.childNodes.map(inline).join("").trim() });
      await htmlBlocks(n.childNodes.filter((x) => x !== sm), c, sink);
    } else await htmlBlocks(n.childNodes, c, sink);      // div, p, center, section
  }
  flushText();
  return sink;
}

// ---- markdown tokens -----------------------------------------------------
// An unbalanced <div align="center"> in one html token centers the tokens that follow until its </div>.
let centerDepth = 0, summaryOpen = 0;
const count = (s, re) => (s.match(re) ?? []).length;
async function paragraph(tok, center) {
  const toks = tok.tokens ?? [];
  const isImg = (t) => t.type === "image" || (t.type === "link" && t.tokens?.length === 1 && t.tokens[0].type === "image");
  if (!toks.some(isImg)) return [{ kind: "para", raw: tok.raw.trim(), center }];
  const res = []; let text = "", group = [];
  const flush = () => { if (group.length) res.push({ kind: "images", items: group, center }); group = []; };
  for (const t of toks) {
    if (isImg(t)) {
      if (text.trim()) { res.push({ kind: "para", raw: text.trim(), center }); text = ""; }
      const im = t.type === "image" ? t : t.tokens[0];
      group.push(await imageBlock(im.href, im.text));
    } else if (t.type === "br" || (t.type === "text" && !t.raw.trim())) { /* gap between images */ }
    else { flush(); text += t.raw; }
  }
  flush();
  if (text.trim()) res.push({ kind: "para", raw: text.trim(), center });
  return res;
}

for (const tok of new Lexer().lex(md)) {
  const center = centerDepth > 0;
  switch (tok.type) {
    case "space": break;
    case "html": {
      const raw = tok.raw;
      centerDepth += count(raw, /<div[^>]*align="center"[^>]*>/gi);
      const root = parseHtml(raw, { blockTextElements: { pre: true } });
      const inDiv = (centerDepth > 0 || center);
      out.push(...(await htmlBlocks(root.childNodes, inDiv)));
      centerDepth = Math.max(0, centerDepth - count(raw, /<\/div>/gi));
      break;
    }
    case "heading": out.push({ kind: "heading", depth: tok.depth, text: tok.text, center }); break;
    case "paragraph": out.push(...(await paragraph(tok, center))); break;
    case "list": out.push({ kind: "list", raw: tok.raw.trim() }); break;
    case "blockquote": out.push({ kind: "quote", raw: tok.text.trim() }); break;
    case "table": out.push({ kind: "table", raw: tok.raw.trim() }); break;
    case "hr": out.push({ kind: "hr" }); break;
    case "code":
      if (tok.lang?.trim().split(/\s/)[0] === "mermaid") out.push(diagram(tok.text));
      else out.push({ kind: "code", lang: (tok.lang ?? "").trim().split(/\s/)[0], text: tok.text });
      break;
    default: if (tok.raw?.trim()) out.push({ kind: "para", raw: tok.raw.trim(), center });
  }
}
const key = createHash("sha1").update(file).digest("hex").slice(0, 12);
writeFileSync(`${outDir}/${key}.json`, JSON.stringify(out));
console.log(key);
