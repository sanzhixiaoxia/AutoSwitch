#!/usr/bin/env node
// 从矢量源生成 assets/icon.png + public/icon.png + assets/icon.ico。
// 位图靠 headless Edge 渲染，尺寸不对或小尺寸糊掉时改这里，而不是改 PNG。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "assets");
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const TOP = "#4a6ff0";
const BOTTOM = "#8f74ff";

// 概念 A 的原始几何（64 网格，样张第 4 格）等比放大到 256：
//   rect x2 y2 w60 h60 rx14 → x8 y8 w240 h240 rx56
//   弧线 M20 27a13 13 0 0 1 22.5-4.2 / M44 37a13 13 0 0 1-22.5 4.2，描边 4 → 16
//   箭头是「开口直角」两段线 M42.5 15.5v7.5h-7.5 / M21.5 48.5V41H29，不是实心三角
//   中心点 r4.2 → r16.8
// 小尺寸降级阶梯（按实渲染核对）：32px 起保留箭头，24px 只留圆环+点，16px 只留点。
const FULL = `
  <path d="M80 108a52 52 0 0 1 90-16.8M176 148a52 52 0 0 1-90 16.8" stroke="#fff" stroke-width="16" fill="none" stroke-linecap="round"/>
  <path d="M170 62v30h-30M86 194v-30h30" stroke="#fff" stroke-width="16" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="128" cy="128" r="16.8" fill="#fff"/>`;
const MID = `
  <path d="M80 108a52 52 0 0 1 90-16.8M176 148a52 52 0 0 1-90 16.8" stroke="#fff" stroke-width="20" fill="none" stroke-linecap="round"/>
  <circle cx="128" cy="128" r="20" fill="#fff"/>`;
const DOT = `<circle cx="128" cy="128" r="36" fill="#fff"/>`;

function svg(size) {
  const mark = size >= 32 ? FULL : size >= 24 ? MID : DOT;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${TOP}"/><stop offset="1" stop-color="${BOTTOM}"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#g)"/>
  ${mark}
</svg>`;
}

function findEdge() {
  const candidates = [
    process.env.AUTOSWITCH_EDGE,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  for (const exe of candidates) if (fs.existsSync(exe)) return exe;
  throw new Error("找不到 msedge.exe，设置 AUTOSWITCH_EDGE 指向 Edge 或 Chrome 可执行文件");
}

function render(edge, size, tmp) {
  const html = path.join(tmp, `icon-${size}.html`);
  const png = path.join(tmp, `icon-${size}.png`);
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>${svg(size)}`);
  const result = spawnSync(
    edge,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--default-background-color=00000000",
      `--window-size=${size},${size}`,
      `--screenshot=${png}`,
      `file:///${html.replace(/\\/g, "/")}`,
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  if (result.status !== 0 || !fs.existsSync(png)) {
    throw new Error(`${size}px 渲染失败（exit ${result.status}）：${(result.stderr || "").slice(0, 300)}`);
  }
  return png;
}

// PNG-in-ICO：Vista 之后都支持，省掉 BMP 编码，256px 也能塞进去。
function buildIco(pngBySize) {
  const entries = SIZES.map((size) => ({ size, data: pngBySize[size] }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(entries.length, 4);
  const SIZE = 20 * entries.length;
  let offset = 6 + SIZE;
  const directory = Buffer.alloc(SIZE);
  entries.forEach((entry, index) => {
    const base = index * 20;
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base);
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1);
    directory.writeUInt16LE(1, base + 4); // planes
    directory.writeUInt16LE(32, base + 6); // bpp
    directory.writeUInt32LE(entry.data.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.data.length;
  });
  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}

const edge = findEdge();
const tmp = fs.mkdtempSync(path.join(process.env.TEMP || ROOT, "as-icon-"));
const pngBySize = {};
try {
  for (const size of SIZES) pngBySize[size] = fs.readFileSync(render(edge, size, tmp));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "icon.ico"), buildIco(pngBySize));
  fs.writeFileSync(path.join(OUT_DIR, "icon.png"), pngBySize[256]);
  fs.writeFileSync(path.join(ROOT, "public", "icon.png"), pngBySize[256]);
  for (const size of SIZES) fs.writeFileSync(path.join(tmp, `keep-${size}.png`), pngBySize[size]);
} finally {
  if (process.env.KEEP_ICON_TMP !== "1") fs.rmSync(tmp, { recursive: true, force: true });
}

const ico = path.join(OUT_DIR, "icon.ico");
console.log(`图标已生成：${ico} ${(fs.statSync(ico).size / 1024).toFixed(1)} KB（${SIZES.join("/")} px）`);
if (process.env.KEEP_ICON_TMP === "1") console.log(`分尺寸 PNG 留在 ${tmp}`);
