import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LangfuseClient } from "@langfuse/client";
import Anthropic from "@anthropic-ai/sdk";

const langfuse = new LangfuseClient();
const anthropic = new Anthropic();

const outDir = join(dirname(fileURLToPath(import.meta.url)), "Evaluator summaries");
mkdirSync(outDir, { recursive: true });

const PALETTE = ["#2a78d6", "#1baf7a", "#eda100", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"];

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

// Renders a horizontal "label above bar" issue-frequency chart as a standalone SVG file -
// avoids needing a native canvas/image-rendering dependency just to save a chart to disk.
function renderIssueFrequencySVG({ evaluatorName, dateRangeLabel, themes, color }) {
  const sorted = [...themes].sort((a, b) => b.count - a.count);
  const maxCount = Math.max(...sorted.map((t) => t.count), 1);

  const width = 900;
  const margin = { top: 70, left: 40, right: 40, bottom: 30 };
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
    rows.push(
      `      ${labelSvg}\n` +
        `      <rect x="${margin.left}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="3" fill="${color}" />\n` +
        `      <text x="${margin.left + barWidth + 8}" y="${barY + barHeight - 4}" font-size="13" font-weight="500" fill="#0b0b0b">${t.count}</text>`
    );
    y = barY + barHeight + gapAfterBar;
  }
  const height = y + margin.bottom;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Arial, sans-serif">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
  <text x="${margin.left}" y="30" font-size="18" font-weight="600" fill="#0b0b0b">${escapeXml(evaluatorName)}</text>
  <text x="${margin.left}" y="50" font-size="13" fill="#52514e">Tagged issue frequency (${escapeXml(dateRangeLabel)})</text>
${rows.join("\n")}
</svg>`;
}

const now = new Date();
const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
const fromTimestamp = oneWeekAgo.toISOString();
const toTimestamp = now.toISOString();
console.log(`Window: ${fromTimestamp} to ${toTimestamp}\n`);

// ============================================================
// 1. Pull every automated-evaluator score in the window (source=EVAL only,
//    so human-review annotations from our own queues aren't mixed in).
// ============================================================
const allScores = [];
{
  let cursor;
  while (true) {
    const { data, meta } = await langfuse.api.scoresV3.getManyV3({
      source: "EVAL",
      fromTimestamp,
      toTimestamp,
      fields: "details",
      limit: 100,
      cursor,
    });
    allScores.push(...data);
    if (!meta.cursor) break;
    cursor = meta.cursor;
  }
}
console.log(`Total EVAL-source scores in window: ${allScores.length}`);

// ============================================================
// 2. Group by evaluator name, filter to non-perfect numeric scores with a comment
// ============================================================
const byEvaluator = new Map(); // name -> [{ value, comment }]
for (const s of allScores) {
  if (s.dataType !== "NUMERIC") continue;
  if (s.value === 1) continue; // perfect score - no signal
  if (!s.comment || !s.comment.trim()) continue;
  if (!byEvaluator.has(s.name)) byEvaluator.set(s.name, []);
  byEvaluator.get(s.name).push({ value: s.value, comment: s.comment.trim() });
}

console.log(`\nEvaluators with non-perfect commented scores: ${byEvaluator.size}`);
for (const [name, entries] of byEvaluator) console.log(`  - ${name}: ${entries.length} comments`);

// ============================================================
// 3. Deduplicate exact-match comments per evaluator, counting occurrences
// ============================================================
function dedupe(entries) {
  const map = new Map(); // comment -> { count, values }
  for (const { value, comment } of entries) {
    if (!map.has(comment)) map.set(comment, { count: 0, values: [] });
    const e = map.get(comment);
    e.count++;
    e.values.push(value);
  }
  return [...map.entries()].map(([comment, e]) => ({ comment, count: e.count, avgValue: e.values.reduce((a, b) => a + b, 0) / e.values.length }));
}

// ============================================================
// 4. Ask Claude to cluster into themes + write a summary paragraph, per evaluator
// ============================================================
const results = {};
const dateRangeLabel = `${fromTimestamp.slice(0, 10)} to ${toTimestamp.slice(0, 10)}`;
const dateRangeSlug = `${fromTimestamp.slice(0, 10)}_to_${toTimestamp.slice(0, 10)}`;
let colorIndex = 0;

for (const [evaluatorName, entries] of byEvaluator) {
  const deduped = dedupe(entries);
  console.log(`\n=== ${evaluatorName} (${entries.length} comments, ${deduped.length} distinct) ===`);

  const commentList = deduped
    .sort((a, b) => b.count - a.count)
    .map((d) => `- "${d.comment}" (occurred ${d.count}x, avg score ${d.avgValue.toFixed(2)})`)
    .join("\n");

  const systemPrompt =
    "You analyze quality-evaluator feedback comments about an AI assistant that helps build OpenFN workflows and job code. " +
    "You will be given a deduplicated list of comments from non-perfect scores by one evaluator, each with how many times " +
    "an identical comment occurred and the average score attached to it. Cluster them into recurring issue themes, then " +
    "write ONE paragraph (3-5 sentences) summarizing the most recurrent issues, citing rough frequency where useful. " +
    'Respond with ONLY valid JSON, no other text: {"themes": [{"label": string, "count": number, "example": string}], "summary": string}';

  let parsed;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 4096,
      thinking: { type: "disabled" },
      system: systemPrompt,
      messages: [{ role: "user", content: commentList }],
    });
    const textBlock = message.content.find((b) => b.type === "text");
    const raw = (textBlock?.text ?? "").trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    try {
      parsed = JSON.parse(raw);
      break;
    } catch {
      console.warn(`Attempt ${attempt}: could not parse JSON response for ${evaluatorName}.`);
      parsed = { themes: [], summary: raw };
    }
  }

  results[evaluatorName] = { commentCount: entries.length, distinctCommentCount: deduped.length, ...parsed };

  console.log(`\nThemes:`);
  for (const t of parsed.themes ?? []) console.log(`  - ${t.label} (x${t.count}): "${t.example}"`);
  console.log(`\nSummary:\n${parsed.summary}`);

  if (parsed.themes?.length) {
    const svg = renderIssueFrequencySVG({
      evaluatorName,
      dateRangeLabel,
      themes: parsed.themes,
      color: PALETTE[colorIndex++ % PALETTE.length],
    });
    const chartFileName = `chart-${slugify(evaluatorName)}-${dateRangeSlug}.svg`;
    writeFileSync(join(outDir, chartFileName), svg, "utf8");
    console.log(`Wrote Evaluator summaries/${chartFileName}`);
  }
}

const txtSections = Object.entries(results).map(
  ([name, r]) => `${name}\n${"-".repeat(name.length)}\n\n${r.summary}`
);
const txtFileName = `evaluator-comment-summaries-${dateRangeSlug}.txt`;
writeFileSync(join(outDir, txtFileName), txtSections.join("\n\n\n"), "utf8");
console.log(`\nWrote summaries for ${Object.keys(results).length} evaluator(s) to Evaluator summaries/${txtFileName}`);
