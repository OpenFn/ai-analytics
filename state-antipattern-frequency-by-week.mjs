import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LangfuseClient } from "@langfuse/client";

const langfuse = new LangfuseClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(scriptDir, "tmp");
mkdirSync(outDir, { recursive: true });

// The literal string to search for in assistant-generated output. Change this
// (and TARGET_LABEL, used only for chart text) to track a different pattern.
const TARGET_STRING = ")(state)";
const TARGET_LABEL = '")(state)" anti-pattern';

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

// Only real user-facing conversations, and only GENERATION-type observations
// (actual LLM completions) - excludes evaluator/dataset-run-item noise, and
// avoids double-counting the same text via wrapper SPAN/EVENT observations
// that just echo a nested generation's output.
const REAL_TRACE_TAGS = ["job_chat", "workflow_chat", "global_chat", "anthropic.chat"];

function countOccurrences(haystack, needle) {
  if (!haystack) return 0;
  return haystack.split(needle).length - 1;
}

// ============================================================
// 1. Pull startTime + output for every real GENERATION observation, all history
// ============================================================
async function fetchGenerations() {
  const generations = [];
  let cursor;
  const filter = JSON.stringify([
    { type: "arrayOptions", column: "tags", operator: "any of", value: REAL_TRACE_TAGS },
    { type: "string", column: "type", operator: "=", value: "GENERATION" },
  ]);
  while (true) {
    const result = await withRetry(
      () => langfuse.api.observations.getMany({ filter, fields: "core,io", limit: 1000, cursor }),
      `observations.getMany cursor=${cursor ?? "start"}`
    );
    if (!result) break;
    for (const obs of result.data) generations.push({ startTime: obs.startTime, output: obs.output });
    console.log(`+${result.data.length} (running total ${generations.length})`);
    if (!result.meta.cursor) break;
    cursor = result.meta.cursor;
  }
  return generations;
}

const generations = await fetchGenerations();
console.log(`\nTotal real GENERATION observations: ${generations.length}`);

if (generations.length === 0) {
  console.log("No observations found - nothing to chart.");
  process.exit(0);
}

// ============================================================
// 2. Count occurrences of TARGET_STRING per observation, bucketed into weeks
//    (rolling 7-day buckets from the earliest observation in the dataset)
// ============================================================
const start = generations.reduce((min, g) => (new Date(g.startTime) < min ? new Date(g.startTime) : min), new Date(generations[0].startTime));
const MS_PER_WEEK = 7 * 24 * 3600 * 1000;

const weekly = new Map(); // weekIndex -> { weekStart, occurrences, matchingObservations }
let totalOccurrences = 0;
let totalMatchingObservations = 0;

for (const g of generations) {
  const count = countOccurrences(g.output, TARGET_STRING);
  if (count === 0) continue;
  totalOccurrences += count;
  totalMatchingObservations++;
  const weekIndex = Math.floor((new Date(g.startTime) - start) / MS_PER_WEEK);
  if (!weekly.has(weekIndex)) {
    const weekStart = new Date(start.getTime() + weekIndex * MS_PER_WEEK).toISOString().slice(0, 10);
    weekly.set(weekIndex, { weekStart, occurrences: 0, matchingObservations: 0 });
  }
  const bucket = weekly.get(weekIndex);
  bucket.occurrences += count;
  bucket.matchingObservations++;
}

// Fill in every week across the full date range, including weeks with zero hits,
// so the chart shows a continuous timeline rather than skipping quiet weeks.
const lastStart = generations.reduce((max, g) => (new Date(g.startTime) > max ? new Date(g.startTime) : max), new Date(generations[0].startTime));
const totalWeeks = Math.floor((lastStart - start) / MS_PER_WEEK) + 1;
const weeklyRows = [];
for (let weekIndex = 0; weekIndex < totalWeeks; weekIndex++) {
  const weekStart = new Date(start.getTime() + weekIndex * MS_PER_WEEK).toISOString().slice(0, 10);
  const bucket = weekly.get(weekIndex);
  weeklyRows.push({ weekStart, occurrences: bucket?.occurrences ?? 0 });
}

console.log(`\nTotal occurrences of ${TARGET_LABEL}: ${totalOccurrences} (across ${totalMatchingObservations} observations)`);
for (const row of weeklyRows) console.log(`${row.weekStart}: ${row.occurrences}`);

// ============================================================
// 3. Render as an SVG bar chart
// ============================================================
function renderWeeklyFrequencySVG({ weeklyRows, dateRangeLabel, totalOccurrences, totalMatchingObservations, totalObservations }) {
  const chartLeft = 50;
  const chartTop = 90;
  const chartHeight = 320;
  const barWidth = 40;
  const barGap = 12;
  const chartRight = chartLeft + weeklyRows.length * (barWidth + barGap);
  const width = chartRight + 30;
  const height = chartTop + chartHeight + 70;
  const maxCount = Math.max(...weeklyRows.map((r) => r.occurrences), 1);

  const bars = weeklyRows
    .map((row, i) => {
      const barHeight = (row.occurrences / maxCount) * chartHeight;
      const x = chartLeft + i * (barWidth + barGap);
      const y = chartTop + chartHeight - barHeight;
      return `
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth}" height="${barHeight.toFixed(1)}" rx="2" fill="#d73027" />
      <text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="11" text-anchor="middle" fill="#0b0b0b">${row.occurrences}</text>
      <text x="${(x + barWidth / 2).toFixed(1)}" y="${(chartTop + chartHeight + 16).toFixed(1)}" font-size="10" text-anchor="middle" fill="#52514e" transform="rotate(45 ${(x + barWidth / 2).toFixed(1)} ${(chartTop + chartHeight + 16).toFixed(1)})">${row.weekStart}</text>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Arial, sans-serif">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
  <text x="40" y="30" font-size="18" font-weight="600" fill="#0b0b0b">Frequency of ${TARGET_LABEL} in assistant responses, by week</text>
  <text x="40" y="50" font-size="13" fill="#52514e">${dateRangeLabel}</text>
  <text x="40" y="66" font-size="13" fill="#52514e">${totalOccurrences} occurrences across ${totalMatchingObservations} of ${totalObservations} real assistant responses scanned</text>
  <line x1="${chartLeft}" y1="${chartTop + chartHeight}" x2="${chartRight}" y2="${chartTop + chartHeight}" stroke="#cccccc" stroke-width="1" />
  ${bars}
</svg>`;
}

const dateRangeLabel = `${start.toISOString().slice(0, 10)} to ${lastStart.toISOString().slice(0, 10)}`;
const svg = renderWeeklyFrequencySVG({
  weeklyRows,
  dateRangeLabel,
  totalOccurrences,
  totalMatchingObservations,
  totalObservations: generations.length,
});
const outPath = join(outDir, "state-antipattern-frequency-by-week.svg");
writeFileSync(outPath, svg, "utf8");
console.log(`\nWrote ${outPath}`);
