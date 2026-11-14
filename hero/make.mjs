// Topographic hero: marching-squares contours of a smooth noise field, title centered.
import { writeFileSync } from "node:fs";
const W = 2400, H = 1200, S = 6;                  // canvas, grid step
const nx = Math.ceil(W / S) + 1, ny = Math.ceil(H / S) + 1;
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const waves = Array.from({ length: 14 }, (_, i) => {
  const k = 0.0016 * (1 + i * 0.55), a = rnd() * Math.PI * 2;
  return { kx: Math.cos(a) * k, ky: Math.sin(a) * k, p: rnd() * 6.28, amp: 1 / (1 + i * 0.5) };
});
const f = (x, y) => {
  let v = 0;
  for (const w of waves) v += w.amp * Math.sin(w.kx * x + w.ky * y + w.p + 0.6 * Math.sin(w.ky * 3 * x));
  return v;
};
const g = [];
let lo = 1e9, hi = -1e9;
for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const v = f(i * S, j * S); g[j * nx + i] = v; lo = Math.min(lo, v); hi = Math.max(hi, v); }
const levels = 44, paths = { minor: [], major: [] };
const lerp = (a, b, t) => a + (b - a) * t;
for (let L = 1; L < levels; L++) {
  const th = lo + (hi - lo) * L / levels, d = [];
  const at = (i, j) => g[j * nx + i];
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const v = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
    const c = (v[0] > th) * 8 + (v[1] > th) * 4 + (v[2] > th) * 2 + (v[3] > th);
    if (c === 0 || c === 15) continue;
    const x = i * S, y = j * S;
    const P = {
      t: [x + S * (th - v[0]) / (v[1] - v[0]), y], r: [x + S, y + S * (th - v[1]) / (v[2] - v[1])],
      b: [x + S * (th - v[3]) / (v[2] - v[3]), y + S], l: [x, y + S * (th - v[0]) / (v[3] - v[0])],
    };
    const segs = { 1: ["l", "b"], 2: ["b", "r"], 3: ["l", "r"], 4: ["t", "r"], 5: ["l", "t", "b", "r"], 6: ["t", "b"], 7: ["l", "t"],
      8: ["l", "t"], 9: ["t", "b"], 10: ["l", "b", "t", "r"], 11: ["t", "r"], 12: ["l", "r"], 13: ["b", "r"], 14: ["l", "b"] }[c];
    for (let s = 0; s < segs.length; s += 2) {
      const a = P[segs[s]], b = P[segs[s + 1]];
      d.push(`M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`);
    }
  }
  (L % 5 === 0 ? paths.major : paths.minor).push(d.join(""));
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="ln" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#4385BE"/><stop offset="0.55" stop-color="#8B7EC8"/><stop offset="1" stop-color="#E8705F"/>
  </linearGradient>
  <radialGradient id="vg" cx="50%" cy="50%" r="60%">
    <stop offset="0" stop-color="#100F0F" stop-opacity="0.96"/><stop offset="0.38" stop-color="#100F0F" stop-opacity="0.82"/>
    <stop offset="1" stop-color="#100F0F" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="edge" cx="50%" cy="50%" r="75%">
    <stop offset="0.6" stop-color="#100F0F" stop-opacity="0"/><stop offset="1" stop-color="#100F0F" stop-opacity="0.85"/>
  </radialGradient>
</defs>
<rect width="${W}" height="${H}" fill="#100F0F"/>
<g fill="none" stroke="url(#ln)" stroke-linecap="round">
  <path d="${paths.minor.join("")}" stroke-width="1.3" opacity="0.42"/>
  <path d="${paths.major.join("")}" stroke-width="2.6" opacity="0.9"/>
</g>
<rect width="${W}" height="${H}" fill="url(#edge)"/>
<ellipse cx="${W / 2}" cy="${H / 2}" rx="${W * 0.34}" ry="${H * 0.3}" fill="url(#vg)"/>
<text x="${W / 2}" y="${H / 2 + 78}" text-anchor="middle" font-family="iA Writer Duo S" font-weight="700" font-size="250" letter-spacing="-4" fill="#CECDC3">isowall</text>
<text x="${W / 2}" y="${H / 2 + 150}" text-anchor="middle" font-family="iA Writer Mono S" font-size="34" letter-spacing="9" fill="#878580">TOPOGRAPHIC WALLPAPERS FOR WAYLAND</text>
</svg>`;
writeFileSync("hero.svg", svg);
