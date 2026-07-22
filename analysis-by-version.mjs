import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LangfuseClient } from "@langfuse/client";

const langfuse = new LangfuseClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(scriptDir, "tmp");
mkdirSync(outDir, { recursive: true });

const CSV_PATH = join(outDir, "scores-by-assistant-version.csv");
const SVG_PATH = join(outDir, "scores-by-assistant-version.svg");

// Deliberately excludes anthropic.chat - only these three are in scope for this analysis.
const TRACE_TYPES = ["job_chat", "workflow_chat", "global_chat"];
const EVALUATORS = ["General openfn quality judge v3", "Workflow quality judge v3", "Code quality judge v5", "General red flag judge v2"];

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
  const traces = [];
  const filter = JSON.stringify([{ type: "string", column: "name", operator: "=", value: name }]);
  let page = 1;
  const limit = 100;
  let totalItems = null;
  while (true) {
    const result = await withRetry(
      () => langfuse.api.trace.list({ page, limit, filter, fields: "core,metrics" }),
      `trace.list(${name}) page ${page}`
    );
    if (result) {
      totalItems = result.meta.totalItems;
      for (const t of result.data) {
        traces.push({ id: t.id, sessionId: t.sessionId, startTime: t.timestamp, latency: t.latency, traceType: name, release: t.release });
      }
      console.log(`${name}: page ${page} (+${result.data.length}), running total ${traces.length}`);
      if (result.data.length === 0 || page * limit >= totalItems) break;
    } else if (totalItems !== null && page * limit >= totalItems) {
      break;
    }
    page++;
  }
  return traces;
}

const allTraces = [];
for (const name of TRACE_TYPES) {
  allTraces.push(...(await fetchTraces(name)));
}
console.log(`\nTotal traces (all history): ${allTraces.length}`);

// Only traces with a known assistant version can be part of a by-version comparison.
const versionedTraces = allTraces.filter((t) => t.release);
console.log(`Traces with a release value set: ${versionedTraces.length} (${allTraces.length - versionedTraces.length} skipped - no release recorded)`);

if (versionedTraces.length === 0) {
  console.log("No versioned traces found - nothing to export.");
  process.exit(0);
}

// ============================================================
// 2. Pull every score from the three evaluators, all history, and index by traceId
// ============================================================
async function fetchScores() {
  const scores = [];
  let cursor;
  while (true) {
    const result = await withRetry(
      () =>
        langfuse.api.scoresV3.getManyV3({
          name: EVALUATORS.join(","),
          dataType: "NUMERIC",
          fields: "subject,details",
          limit: 100,
          cursor,
        }),
      `scoresV3.getManyV3 cursor=${cursor ?? "start"}`
    );
    if (!result) break;
    scores.push(...result.data);
    if (!result.meta.cursor) break;
    cursor = result.meta.cursor;
  }
  return scores;
}

const scores = await fetchScores();
console.log(`Total evaluator scores fetched: ${scores.length}`);

// traceId -> evaluatorName -> { value, comment, observationId, timestamp }
const scoresByTrace = new Map();
for (const s of scores) {
  if (s.subject?.kind !== "observation" || !s.subject.traceId) continue;
  if (!EVALUATORS.includes(s.name)) continue;
  const traceId = s.subject.traceId;
  if (!scoresByTrace.has(traceId)) scoresByTrace.set(traceId, {});
  const byEvaluator = scoresByTrace.get(traceId);
  const existing = byEvaluator[s.name];
  if (!existing || new Date(s.timestamp) > new Date(existing.timestamp)) {
    byEvaluator[s.name] = { value: s.value, comment: s.comment ?? "", observationId: s.subject.id, timestamp: s.timestamp };
  }
}

// ============================================================
// 3. Build CSV rows, skipping traces already present in the existing file
// ============================================================
const existingContent = existsSync(CSV_PATH) ? readFileSync(CSV_PATH, "utf8") : "";
const isNewFile = existingContent.length === 0;

const header = [
  "traceId",
  "sessionId",
  "startTime",
  "latency",
  "traceType",
  "release",
  ...EVALUATORS.flatMap((name) => [`${name} - observation ID`, `${name} - score`, `${name} - comment`]),
];

const newRows = [];
let skippedAlreadyPresent = 0;
for (const t of versionedTraces) {
  if (existingContent.includes(t.id)) {
    skippedAlreadyPresent++;
    continue;
  }
  const byEvaluator = scoresByTrace.get(t.id) ?? {};
  const row = [t.id, t.sessionId, t.startTime, t.latency, t.traceType, t.release];
  for (const name of EVALUATORS) {
    const s = byEvaluator[name];
    row.push(s?.observationId ?? "", s?.value ?? "", s?.comment ?? "");
  }
  newRows.push(row);
}

console.log(`\nNew rows to append: ${newRows.length} (${skippedAlreadyPresent} already present from a previous run)`);

if (newRows.length > 0) {
  if (isNewFile) {
    writeFileSync(CSV_PATH, header.map(csvField).join(",") + "\n", "utf8");
  }
  const csvLines = newRows.map((row) => row.map(csvField).join(",")).join("\n") + "\n";
  appendFileSync(CSV_PATH, csvLines, "utf8");
  console.log(`Wrote ${CSV_PATH}`);
} else {
  console.log("Nothing new to append to the CSV.");
}

// ============================================================
// 4. Render the SVG: one panel per evaluator, mean score +/- stdev by version,
//    always built from the full freshly-fetched dataset (not just new rows).
// ============================================================
function groupByVersion(evaluatorName) {
  // versionKey -> { firstSeen, values: [] }
  const byVersion = new Map();
  for (const t of versionedTraces) {
    const s = scoresByTrace.get(t.id)?.[evaluatorName];
    if (!s || typeof s.value !== "number") continue;
    if (!byVersion.has(t.release)) byVersion.set(t.release, { firstSeen: t.startTime, values: [] });
    const bucket = byVersion.get(t.release);
    if (t.startTime < bucket.firstSeen) bucket.firstSeen = t.startTime;
    bucket.values.push(s.value);
  }
  const rows = [...byVersion.entries()].map(([release, { firstSeen, values }]) => ({ release, firstSeen, n: values.length, values }));
  rows.sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
  return rows;
}

function renderPanel({ title, rows, panelTop, panelHeight, chartLeft, chartRight, maxScale, formatValue = (v) => v.toFixed(2) }) {
  const titleY = panelTop + 16;
  const chartTop = panelTop + 30;
  const chartHeight = panelHeight - 60;
  const chartBottom = chartTop + chartHeight;
  const minScale = 0; // scores and latency are both non-negative
  const scaleY = (v) => chartBottom - ((v - minScale) / (maxScale - minScale)) * chartHeight;
  const slotWidth = (chartRight - chartLeft) / Math.max(rows.length, 1);
  const jitterWidth = Math.min(50, slotWidth * 0.6);

  // Y axis: 5 evenly spaced ticks from 0 to maxScale, with gridlines and value labels.
  const tickCount = 5;
  const yAxis = Array.from({ length: tickCount + 1 }, (_, i) => {
    const value = (maxScale * i) / tickCount;
    const y = scaleY(value);
    return `
      <line x1="${chartLeft}" y1="${y.toFixed(1)}" x2="${chartRight}" y2="${y.toFixed(1)}" stroke="#e6e6e6" stroke-width="1" />
      <text x="${(chartLeft - 8).toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="10" text-anchor="end" fill="#52514e">${formatValue(value)}</text>`;
  }).join("");
  const axisLine = `<line x1="${chartLeft}" y1="${chartTop}" x2="${chartLeft}" y2="${chartBottom}" stroke="#999999" stroke-width="1" />`;

  const points = rows
    .map((r, i) => {
      const cx = chartLeft + slotWidth * (i + 0.5);
      const mean = r.values.reduce((a, b) => a + b, 0) / r.n;
      const meanY = scaleY(mean);
      const dots = r.values
        .map((v) => {
          const x = cx + (Math.random() - 0.5) * jitterWidth;
          const y = scaleY(v);
          return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="#4575b4" fill-opacity="0.55" />`;
        })
        .join("");
      return `
      ${dots}
      <line x1="${(cx - jitterWidth / 2).toFixed(1)}" y1="${meanY.toFixed(1)}" x2="${(cx + jitterWidth / 2).toFixed(1)}" y2="${meanY.toFixed(1)}" stroke="#d73027" stroke-width="1.5" stroke-dasharray="4 3" />
      <text x="${(cx + jitterWidth / 2 + 4).toFixed(1)}" y="${(meanY + 4).toFixed(1)}" font-size="11" font-weight="600" text-anchor="start" fill="#d73027">avg ${formatValue(mean)}</text>
      <text x="${cx.toFixed(1)}" y="${(chartBottom + 16).toFixed(1)}" font-size="12" font-weight="600" text-anchor="middle" fill="#0b0b0b">${r.release}</text>
      <text x="${cx.toFixed(1)}" y="${(chartBottom + 30).toFixed(1)}" font-size="10" text-anchor="middle" fill="#52514e">n=${r.n}</text>`;
    })
    .join("");

  return `
  <text x="${chartLeft}" y="${titleY}" font-size="14" font-weight="600" fill="#0b0b0b">${title}</text>
  ${yAxis}
  ${axisLine}
  ${points}`;
}

function groupLatencyByVersion() {
  const byVersion = new Map();
  for (const t of versionedTraces) {
    if (typeof t.latency !== "number") continue;
    if (!byVersion.has(t.release)) byVersion.set(t.release, { firstSeen: t.startTime, values: [] });
    const bucket = byVersion.get(t.release);
    if (t.startTime < bucket.firstSeen) bucket.firstSeen = t.startTime;
    bucket.values.push(t.latency);
  }
  const rows = [...byVersion.entries()].map(([release, { firstSeen, values }]) => ({ release, firstSeen, n: values.length, values }));
  rows.sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
  return rows;
}

function computeTraceTypeMix() {
  const byVersion = new Map();
  for (const t of versionedTraces) {
    if (!byVersion.has(t.release)) byVersion.set(t.release, { firstSeen: t.startTime, total: 0, byType: {} });
    const b = byVersion.get(t.release);
    if (t.startTime < b.firstSeen) b.firstSeen = t.startTime;
    b.total++;
    b.byType[t.traceType] = (b.byType[t.traceType] ?? 0) + 1;
  }
  const rows = [...byVersion.entries()].map(([release, { firstSeen, total, byType }]) => ({ release, firstSeen, total, byType }));
  rows.sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
  return rows;
}

function renderTraceTypeMixTable({ rows, panelTop, chartLeft, chartRight }) {
  const titleY = panelTop + 16;
  const headerY = panelTop + 40;
  const rowHeight = 22;
  const colX = { version: chartLeft, n: chartLeft + 110, job: chartLeft + 190, workflow: chartLeft + 370, global: chartLeft + 570 };

  const header = `
  <text x="${colX.version}" y="${headerY}" font-size="12" font-weight="600" fill="#52514e">Version</text>
  <text x="${colX.n}" y="${headerY}" font-size="12" font-weight="600" fill="#52514e">n</text>
  <text x="${colX.job}" y="${headerY}" font-size="12" font-weight="600" fill="#52514e">job_chat</text>
  <text x="${colX.workflow}" y="${headerY}" font-size="12" font-weight="600" fill="#52514e">workflow_chat</text>
  <text x="${colX.global}" y="${headerY}" font-size="12" font-weight="600" fill="#52514e">global_chat</text>
  <line x1="${chartLeft}" y1="${headerY + 6}" x2="${chartRight}" y2="${headerY + 6}" stroke="#999999" stroke-width="1" />`;

  const dataRows = rows
    .map((r, i) => {
      const y = headerY + 6 + rowHeight * (i + 1);
      const cell = (type) => {
        const count = r.byType[type] ?? 0;
        return `${count} (${((count / r.total) * 100).toFixed(1)}%)`;
      };
      return `
  <text x="${colX.version}" y="${y}" font-size="12" font-weight="600" fill="#0b0b0b">${r.release}</text>
  <text x="${colX.n}" y="${y}" font-size="12" fill="#0b0b0b">${r.total}</text>
  <text x="${colX.job}" y="${y}" font-size="12" fill="#0b0b0b">${cell("job_chat")}</text>
  <text x="${colX.workflow}" y="${y}" font-size="12" fill="#0b0b0b">${cell("workflow_chat")}</text>
  <text x="${colX.global}" y="${y}" font-size="12" fill="#0b0b0b">${cell("global_chat")}</text>`;
    })
    .join("");

  return `
  <text x="${chartLeft}" y="${titleY}" font-size="14" font-weight="600" fill="#0b0b0b">Trace type mix by version</text>
  ${header}
  ${dataRows}`;
}

const panelHeight = 200;
const chartLeft = 60;
const chartRight = 840;
const width = 900;
const panelCount = EVALUATORS.length + 1; // + 1 for the latency-by-version panel
const traceTypeMixRows = computeTraceTypeMix();
const tableHeight = 60 + 22 * traceTypeMixRows.length + 20;
const height = panelHeight * panelCount + tableHeight + 40;

const scorePanels = EVALUATORS.map((name, i) => {
  const rows = groupByVersion(name);
  return renderPanel({
    title: name,
    rows,
    panelTop: 20 + i * panelHeight,
    panelHeight,
    chartLeft,
    chartRight,
    maxScale: Math.max(1, ...rows.flatMap((r) => r.values)),
  });
});

const latencyRows = groupLatencyByVersion();
const latencyPanel = renderPanel({
  title: "Latency (seconds)",
  rows: latencyRows,
  panelTop: 20 + EVALUATORS.length * panelHeight,
  panelHeight,
  chartLeft,
  chartRight,
  maxScale: Math.max(...latencyRows.flatMap((r) => r.values)) * 1.1,
  formatValue: (v) => `${v.toFixed(1)}s`,
});

const traceTypeMixTable = renderTraceTypeMixTable({
  rows: traceTypeMixRows,
  panelTop: 20 + panelCount * panelHeight,
  chartLeft,
  chartRight,
});

const panels = [...scorePanels, latencyPanel, traceTypeMixTable].join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Arial, sans-serif">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
  ${panels}
</svg>`;

writeFileSync(SVG_PATH, svg, "utf8");
console.log(`Wrote ${SVG_PATH}`);
