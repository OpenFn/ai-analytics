import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LangfuseClient } from "@langfuse/client";

const langfuse = new LangfuseClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(scriptDir, "tmp");
mkdirSync(outDir, { recursive: true });
const CSV_PATH = join(outDir, "traces-per-week-by-type.csv");

const TRACE_TYPES = ["job_chat", "workflow_chat", "global_chat"];

async function withRetry(fn, label) {
  let attempt = 0;
  while (attempt < 3) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      console.warn(`${label} attempt ${attempt} failed (${err.statusCode ?? err.message})`);
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  console.warn(`${label} skipped after 3 failed attempts.`);
  return null;
}

function csvField(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ============================================================
// 1. Pull every job_chat/workflow_chat/global_chat trace, all history
// ============================================================
async function fetchTraces(name) {
  const timestamps = [];
  const filter = JSON.stringify([{ type: "string", column: "name", operator: "=", value: name }]);
  let page = 1;
  const limit = 100;
  let totalItems = null;
  while (true) {
    const result = await withRetry(
      () => langfuse.api.trace.list({ page, limit, filter, fields: "core" }),
      `trace.list(${name}) page ${page}`
    );
    if (result) {
      totalItems = result.meta.totalItems;
      for (const t of result.data) timestamps.push(t.timestamp);
      console.log(`${name}: page ${page} (+${result.data.length}), running total ${timestamps.length}`);
      if (result.data.length === 0 || page * limit >= totalItems) break;
    } else if (totalItems !== null && page * limit >= totalItems) {
      break;
    }
    page++;
  }
  return timestamps;
}

const byType = {};
for (const name of TRACE_TYPES) {
  byType[name] = await fetchTraces(name);
}

const allTimestamps = Object.values(byType).flat();
console.log(`\nTotal traces (all history): ${allTimestamps.length}`);

if (allTimestamps.length === 0) {
  console.log("No traces found - nothing to export.");
  process.exit(0);
}

// ============================================================
// 2. Bucket into rolling 7-day weeks from the earliest trace, per type
// ============================================================
const start = allTimestamps.reduce((min, t) => (t < min ? t : min), allTimestamps[0]);
const startDate = new Date(start);
const MS_PER_WEEK = 7 * 24 * 3600 * 1000;

const weekCounts = new Map(); // weekIndex -> { job_chat, workflow_chat, global_chat }
for (const name of TRACE_TYPES) {
  for (const t of byType[name]) {
    const weekIndex = Math.floor((new Date(t) - startDate) / MS_PER_WEEK);
    if (!weekCounts.has(weekIndex)) weekCounts.set(weekIndex, { job_chat: 0, workflow_chat: 0, global_chat: 0 });
    weekCounts.get(weekIndex)[name]++;
  }
}

const lastTimestamp = allTimestamps.reduce((max, t) => (t > max ? t : max), allTimestamps[0]);
const totalWeeks = Math.floor((new Date(lastTimestamp) - startDate) / MS_PER_WEEK) + 1;

const rows = [];
for (let weekIndex = 0; weekIndex < totalWeeks; weekIndex++) {
  const weekStart = new Date(startDate.getTime() + weekIndex * MS_PER_WEEK).toISOString().slice(0, 10);
  const weekEnd = new Date(startDate.getTime() + (weekIndex + 1) * MS_PER_WEEK).toISOString().slice(0, 10);
  const counts = weekCounts.get(weekIndex) ?? { job_chat: 0, workflow_chat: 0, global_chat: 0 };
  const total = counts.job_chat + counts.workflow_chat + counts.global_chat;
  rows.push({ weekStart, weekEnd, ...counts, total });
}

console.log(`\nTraces per week:`);
for (const r of rows) console.log(`${r.weekStart} to ${r.weekEnd}: job_chat=${r.job_chat} workflow_chat=${r.workflow_chat} global_chat=${r.global_chat} total=${r.total}`);

// ============================================================
// 3. Write CSV (overwritten fresh each run - not append-only)
// ============================================================
const header = ["weekStart", "weekEnd", "job_chat", "workflow_chat", "global_chat", "total"];
const lines = [header.map(csvField).join(",")];
for (const r of rows) {
  lines.push([r.weekStart, r.weekEnd, r.job_chat, r.workflow_chat, r.global_chat, r.total].map(csvField).join(","));
}
writeFileSync(CSV_PATH, lines.join("\n") + "\n", "utf8");
console.log(`\nWrote ${CSV_PATH}`);

// ============================================================
// 4. Render as a stacked bar chart SVG
// ============================================================
const TRACE_TYPE_COLORS = { job_chat: "#4575b4", workflow_chat: "#1a9850", global_chat: "#e08214" };

function renderStackedBarSVG(rows) {
  const chartLeft = 60;
  const chartTop = 90;
  const chartHeight = 320;
  const barWidth = 40;
  const barGap = 12;
  const chartRight = chartLeft + rows.length * (barWidth + barGap);
  const width = chartRight + 30;
  const height = chartTop + chartHeight + 90;
  const maxTotal = Math.max(...rows.map((r) => r.total), 1);
  const scaleY = (v) => (v / maxTotal) * chartHeight;

  const legend = TRACE_TYPES.map(
    (name, i) => `
    <rect x="${chartLeft + i * 160}" y="30" width="12" height="12" fill="${TRACE_TYPE_COLORS[name]}" />
    <text x="${chartLeft + i * 160 + 18}" y="40" font-size="12" fill="#0b0b0b">${name}</text>`
  ).join("");

  const gridline = `<line x1="${chartLeft}" y1="${chartTop + chartHeight}" x2="${chartRight}" y2="${chartTop + chartHeight}" stroke="#cccccc" stroke-width="1" />`;

  const bars = rows
    .map((r, i) => {
      const x = chartLeft + i * (barWidth + barGap);
      let yCursor = chartTop + chartHeight;
      const segments = TRACE_TYPES.map((name) => {
        const segHeight = scaleY(r[name]);
        yCursor -= segHeight;
        return `<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${barWidth}" height="${segHeight.toFixed(1)}" fill="${TRACE_TYPE_COLORS[name]}" />`;
      }).join("");
      const topY = chartTop + chartHeight - scaleY(r.total);
      return `
      ${segments}
      <text x="${(x + barWidth / 2).toFixed(1)}" y="${(topY - 4).toFixed(1)}" font-size="11" text-anchor="middle" fill="#0b0b0b">${r.total}</text>
      <text x="${(x + barWidth / 2).toFixed(1)}" y="${(chartTop + chartHeight + 16).toFixed(1)}" font-size="10" text-anchor="middle" fill="#52514e" transform="rotate(45 ${(x + barWidth / 2).toFixed(1)} ${(chartTop + chartHeight + 16).toFixed(1)})">${r.weekStart}</text>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Arial, sans-serif">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
  <text x="${chartLeft}" y="20" font-size="18" font-weight="600" fill="#0b0b0b">Traces per week by type</text>
  ${legend}
  ${gridline}
  ${bars}
</svg>`;
}

const SVG_PATH = join(outDir, "traces-per-week-by-type.svg");
writeFileSync(SVG_PATH, renderStackedBarSVG(rows), "utf8");
console.log(`Wrote ${SVG_PATH}`);
