import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LangfuseClient } from "@langfuse/client";

const langfuse = new LangfuseClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(scriptDir, "tmp");
mkdirSync(outDir, { recursive: true });

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

// Only real user-facing conversations - excludes "Execute_evaluator" traces and
// "dataset-run-item-*" batch/manual test scaffolding, which would otherwise skew
// an hour-of-day usage chart towards whenever evaluator runs happen to fire.
//
// NOTE: the observations-v2 endpoint's own "traceName" field is unreliable - it
// comes back empty for real conversation traces even though the trace itself has
// a proper "name" (confirmed by cross-checking trace.list directly). The parent
// trace's tags are populated correctly on every observation though, so we filter
// on those instead.
const REAL_TRACE_TAGS = ["job_chat", "workflow_chat", "global_chat", "anthropic.chat"];

// ============================================================
// 1. Pull startTime for every real observation, across all history
// ============================================================
async function fetchStartTimes() {
  const startTimes = [];
  let cursor;
  const filter = JSON.stringify([{ type: "arrayOptions", column: "tags", operator: "any of", value: REAL_TRACE_TAGS }]);
  while (true) {
    const result = await withRetry(
      () => langfuse.api.observations.getMany({ filter, fields: "core", limit: 1000, cursor }),
      `observations.getMany cursor=${cursor ?? "start"}`
    );
    if (!result) break;
    for (const obs of result.data) startTimes.push(obs.startTime);
    console.log(`+${result.data.length} (running total ${startTimes.length})`);
    if (!result.meta.cursor) break;
    cursor = result.meta.cursor;
  }
  return startTimes;
}

const allStartTimes = await fetchStartTimes();
console.log(`\nTotal real observations: ${allStartTimes.length}`);

if (allStartTimes.length === 0) {
  console.log("No observations found - nothing to chart.");
  process.exit(0);
}

// ============================================================
// 2. Bucket by UTC hour-of-day, average over the number of days spanned
// ============================================================
const hourCounts = new Array(24).fill(0);
let minDate = null;
let maxDate = null;
for (const iso of allStartTimes) {
  const d = new Date(iso);
  hourCounts[d.getUTCHours()]++;
  if (!minDate || d < minDate) minDate = d;
  if (!maxDate || d > maxDate) maxDate = d;
}

const MS_PER_DAY = 24 * 3600 * 1000;
const totalDays = Math.floor((maxDate - minDate) / MS_PER_DAY) + 1;
const hourAverages = hourCounts.map((c) => c / totalDays);

console.log(`\nDate range: ${minDate.toISOString().slice(0, 10)} to ${maxDate.toISOString().slice(0, 10)} (${totalDays} days)`);
for (let h = 0; h < 24; h++) {
  console.log(`${String(h).padStart(2, "0")}:00 UTC - ${hourCounts[h]} total, ${hourAverages[h].toFixed(2)} avg/day`);
}

// ============================================================
// 3. Render as an SVG bar chart
// ============================================================
function renderHourlyFrequencySVG({ hourAverages, dateRangeLabel, totalCount, totalDays }) {
  const width = 900;
  const chartLeft = 50;
  const chartRight = width - 30;
  const chartTop = 90;
  const chartHeight = 320;
  const barGap = 4;
  const barWidth = (chartRight - chartLeft - barGap * 23) / 24;
  const maxAvg = Math.max(...hourAverages);
  const height = chartTop + chartHeight + 60;

  const bars = hourAverages
    .map((avg, hour) => {
      const barHeight = maxAvg > 0 ? (avg / maxAvg) * chartHeight : 0;
      const x = chartLeft + hour * (barWidth + barGap);
      const y = chartTop + chartHeight - barHeight;
      const label = avg.toFixed(2);
      return `
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="2" fill="#4575b4" />
      <text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="10" text-anchor="middle" fill="#0b0b0b">${label}</text>
      <text x="${(x + barWidth / 2).toFixed(1)}" y="${(chartTop + chartHeight + 16).toFixed(1)}" font-size="11" text-anchor="middle" fill="#52514e">${String(hour).padStart(2, "0")}</text>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Arial, sans-serif">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
  <text x="40" y="30" font-size="18" font-weight="600" fill="#0b0b0b">Observation frequency by hour of day (UTC)</text>
  <text x="40" y="50" font-size="13" fill="#52514e">${dateRangeLabel}</text>
  <text x="40" y="66" font-size="13" fill="#52514e">${totalCount} real observations over ${totalDays} days - average count per hour-of-day shown</text>
  <line x1="${chartLeft}" y1="${chartTop + chartHeight}" x2="${chartRight}" y2="${chartTop + chartHeight}" stroke="#cccccc" stroke-width="1" />
  ${bars}
</svg>`;
}

const dateRangeLabel = `${minDate.toISOString().slice(0, 10)} to ${maxDate.toISOString().slice(0, 10)}`;
const svg = renderHourlyFrequencySVG({ hourAverages, dateRangeLabel, totalCount: allStartTimes.length, totalDays });
const outPath = join(outDir, "observations-by-hour-of-day.svg");
writeFileSync(outPath, svg, "utf8");
console.log(`\nWrote ${outPath}`);
