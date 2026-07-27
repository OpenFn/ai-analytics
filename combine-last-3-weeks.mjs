import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const summariesDir = join(scriptDir, "tmp", "Evaluator summaries");

// Which evaluators to combine, and where their weekly CSV history lives.
const EVALUATORS = [
  { name: "General red flag judge v2", csvFileName: "general-red-flag-judge-v2-summary.csv" },
  { name: "Code quality judge v5", csvFileName: "code-quality-judge-v5-summary.csv" },
];
const WEEKS_TO_COMBINE = 3;

// Same semantics as summarize-evaluator-comments.mjs's chart coloring, duplicated here
// since this script only reads the CSV history - it never touches Langfuse or Anthropic.
const NO_ISSUES_TAG = "No issues found";
const NO_CODE_TAG = "suggested_code: null";
const BENIGN_TAGS = ["Assistant pushed back and asked a reasonable and necessary clarifying question"];

function colorForTag(tag) {
  if (tag === NO_ISSUES_TAG || BENIGN_TAGS.includes(tag)) return "#1a9850"; // green
  if (tag === NO_CODE_TAG) return "#8c8c8c"; // grey
  return "#d73027"; // red - genuine issue
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function escapeXml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function wrapText(text, maxCharsPerLine) {
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > maxCharsPerLine) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = (current + " " + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines;
}

function renderIssueFrequencySVG({ evaluatorName, dateRangeLabel, bars, totalCount }) {
  const sorted = [...bars].sort((a, b) => b.count - a.count);
  const maxCount = Math.max(...sorted.map((t) => t.count), 1);

  const width = 900;
  const topMargin = totalCount != null ? 86 : 70;
  const margin = { top: topMargin, left: 40, right: 120, bottom: 30 };
  const barAreaWidth = width - margin.left - margin.right;
  const barHeight = 18;
  const labelLineHeight = 17;
  const gapAfterBar = 18;
  const maxCharsPerLine = 100;

  let y = margin.top;
  const rows = [];
  for (const t of sorted) {
    const lines = wrapText(t.label, maxCharsPerLine);
    const labelSvg = lines
      .map((line, i) => `<text x="${margin.left}" y="${y + i * labelLineHeight}" font-size="13" fill="#0b0b0b">${escapeXml(line)}</text>`)
      .join("\n      ");
    const barY = y + lines.length * labelLineHeight + 4;
    const barWidth = Math.round(Math.max((t.count / maxCount) * barAreaWidth, 2) * 10) / 10;
    const pctSuffix = totalCount ? ` (${((t.count / totalCount) * 100).toFixed(1)}%)` : "";
    rows.push(
      `      ${labelSvg}\n` +
        `      <rect x="${margin.left}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="3" fill="${t.color}" />\n` +
        `      <text x="${margin.left + barWidth + 8}" y="${barY + barHeight - 4}" font-size="13" font-weight="500" fill="#0b0b0b">${t.count}${pctSuffix}</text>`
    );
    y = barY + barHeight + gapAfterBar;
  }
  const height = y + margin.bottom;

  const noteLine =
    totalCount != null
      ? `\n  <text x="${margin.left}" y="66" font-size="13" fill="#52514e">${totalCount} comments with score &lt;1.0 across this period</text>`
      : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Arial, sans-serif">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
  <text x="${margin.left}" y="30" font-size="18" font-weight="600" fill="#0b0b0b">${escapeXml(evaluatorName)}</text>
  <text x="${margin.left}" y="50" font-size="13" fill="#52514e">Tagged issue frequency (${escapeXml(dateRangeLabel)})</text>${noteLine}
${rows.join("\n")}
</svg>`;
}

// ============================================================
// Minimal quote-aware CSV parser (handles commas/quotes inside fields, e.g.
// tag names like "Lazy state evaluation, a bare `state.x`")
// ============================================================
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // skip, handled by \n
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ============================================================
// For each evaluator: sum the last WEEKS_TO_COMBINE rows of its CSV history
// ============================================================
for (const { name, csvFileName } of EVALUATORS) {
  const csvPath = join(summariesDir, csvFileName);
  const text = readFileSync(csvPath, "utf8");
  const allRows = parseCsv(text).filter((r) => r.length > 1);
  const header = allRows[0];
  const dataRows = allRows.slice(1, 1 + WEEKS_TO_COMBINE); // rows are appended most-recent-first

  const iStart = header.indexOf("startDate");
  const iEnd = header.indexOf("endDate");
  const iTotal = header.indexOf("total");
  const tagColumns = header.slice(3); // everything after startDate,endDate,total

  const tagTotals = new Map();
  let totalCount = 0;
  for (const row of dataRows) {
    totalCount += Number(row[iTotal]) || 0;
    for (let i = 0; i < tagColumns.length; i++) {
      const tag = tagColumns[i];
      const count = Number(row[3 + i]) || 0;
      if (count === 0) continue;
      tagTotals.set(tag, (tagTotals.get(tag) ?? 0) + count);
    }
  }

  const weekStarts = dataRows.map((r) => r[iStart]).sort();
  const weekEnds = dataRows.map((r) => r[iEnd]).sort();
  const dateRangeLabel = `${weekStarts[0]} to ${weekEnds[weekEnds.length - 1]}, last ${dataRows.length} week(s)`;

  const top15 = [...tagTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log(`\n${name} - combined tag counts over ${dataRows.length} week(s) (${dateRangeLabel}):`);
  for (const [tag, count] of top15) console.log(`  ${count}\t${tag}`);

  if (top15.length === 0) {
    console.log(`  No tagged issues found - skipping chart.`);
    continue;
  }

  const bars = top15.map(([label, count]) => ({ label, count, color: colorForTag(label) }));
  const svg = renderIssueFrequencySVG({ evaluatorName: name, dateRangeLabel, bars, totalCount });
  const outPath = join(summariesDir, `chart-${slugify(name)}-last-3-weeks.svg`);
  writeFileSync(outPath, svg, "utf8");
  console.log(`Wrote ${outPath}`);
}
