import { writeFileSync, appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LangfuseClient } from "@langfuse/client";
import Anthropic from "@anthropic-ai/sdk";

const langfuse = new LangfuseClient();
const anthropic = new Anthropic();

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(scriptDir, "tmp", "Evaluator summaries");
mkdirSync(outDir, { recursive: true });

// Evaluators using a fixed issue-tag vocabulary, so their week-over-week bar charts and CSV
// history stay comparable. Add an entry here (and a matching tags file) for any new evaluator.
const FIXED_TAG_EVALUATORS = {
  "Code quality judge v5": "issue-tags-for-code-judge-comment-summariser.txt",
  "Workflow quality judge v3": "issue-tags-for-workflow-judge-comment-summariser.txt",
  "General openfn quality judge v3": "issue-tags-for-general-openfn-judge-comment-summariser.txt",
  "General red flag judge v2": "issue-tags-for-general-red-flag-judge-comment-summariser.txt",
};
const NO_ISSUES_TAG = "No issues found";
const NO_CODE_TAG = "suggested_code: null";
// Non-issue tags in the "General red flag judge v2" vocabulary that should chart as
// benign (green), same as NO_ISSUES_TAG, rather than as a genuine red flag (red).
const BENIGN_TAGS = ["Assistant pushed back and asked a reasonable and necessary clarifying question"];

function csvField(value) {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// Appends one row (this week's counts, one column per tag in the fixed vocabulary) to the
// evaluator's CSV history file. Writes the header first if the file doesn't exist yet.
function appendFixedTagCsvRow({ csvFileName, allTags, tagTotals, totalCount, fromDate, toDate }) {
  const csvPath = join(outDir, csvFileName);
  const headerCols = ["startDate", "endDate", "total", ...allTags];
  const dataCols = [fromDate, toDate, totalCount, ...allTags.map((tag) => tagTotals.get(tag) ?? 0)];
  const dataRow = dataCols.map(csvField).join(",") + "\n";

  if (!existsSync(csvPath)) {
    writeFileSync(csvPath, headerCols.map(csvField).join(",") + "\n" + dataRow, "utf8");
  } else {
    appendFileSync(csvPath, dataRow, "utf8");
  }
  console.log(`Appended row to tmp/Evaluator summaries/${csvFileName}`);
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

// Renders a horizontal "label above bar" issue-frequency chart as a standalone SVG file -
// avoids needing a native canvas/image-rendering dependency just to save a chart to disk.
// bars: [{ label, count, color }] - color is per-bar so fixed-tag charts can use semantic colors.
// totalCount (optional): when provided, adds a "N comments this week" note and a per-bar
// percentage of that total - e.g. "13 (6.4%)" - next to the absolute count.
function renderIssueFrequencySVG({ evaluatorName, dateRangeLabel, bars, totalCount }) {
  const sorted = [...bars].sort((a, b) => b.count - a.count);
  const maxCount = Math.max(...sorted.map((t) => t.count), 1);

  const width = 900;
  const topMargin = totalCount != null ? 86 : 70; // extra room for the total-comments note line
  const margin = { top: topMargin, left: 40, right: 120, bottom: 30 }; // wide right margin - percentage labels are long
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
      ? `\n  <text x="${margin.left}" y="66" font-size="13" fill="#52514e">${totalCount} comments with score &lt;1.0 this week</text>`
      : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Arial, sans-serif">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
  <text x="${margin.left}" y="30" font-size="18" font-weight="600" fill="#0b0b0b">${escapeXml(evaluatorName)}</text>
  <text x="${margin.left}" y="50" font-size="13" fill="#52514e">Tagged issue frequency (${escapeXml(dateRangeLabel)})</text>${noteLine}
${rows.join("\n")}
</svg>`;
}

// ============================================================
// Fixed issue-tag vocabulary loading (bullet list, "## Section:" headers ignored)
// ============================================================
function loadTagVocabulary(filePath) {
  const lines = readFileSync(filePath, "utf8").split("\n");
  const tags = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) continue;
    const tag = trimmed.replace(/^[\s-]+/, "").trim();
    if (tag) tags.push(tag);
  }
  return tags;
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

function colorForTag(tag) {
  if (tag === NO_ISSUES_TAG || BENIGN_TAGS.includes(tag)) return "#1a9850"; // green
  if (tag === NO_CODE_TAG) return "#8c8c8c"; // grey
  return "#d73027"; // red - genuine issue
}

// Anthropic's tool-use "enum" constraint guarantees valid JSON *shape*, but has been observed
// to still let a near-miss string through (e.g. a dropped backtick), which would otherwise
// silently create a duplicate/phantom tag. Normalize away punctuation/whitespace/case before
// comparing, and map back to the real vocabulary string so counts merge correctly.
function normalizeForMatching(s) {
  return s.toLowerCase().replace(/[`'"]/g, "").replace(/\s+/g, " ").trim();
}

function buildTagMatcher(allTags) {
  const byNormalized = new Map(allTags.map((t) => [normalizeForMatching(t), t]));
  return (rawTag) => byNormalized.get(normalizeForMatching(rawTag)) ?? null;
}

// Classifies one batch of deduplicated comments against the fixed tag vocabulary, using
// Anthropic's tool-use (structured output) so the response is schema-constrained rather than
// free-text JSON we have to parse and hope is valid - "tags" can ONLY be one of allTags
// (enforced by the enum), and can never contain the same tag twice (enforced by uniqueItems).
// This eliminates the stray-bracket JSON-parse failures the free-form pipeline still has, but
// the enum isn't a perfect guarantee of exact-string adherence - see normalizeForMatching above.
async function classifyBatch(batch, allTags, evaluatorName) {
  const matchTag = buildTagMatcher(allTags);
  const tagListText = allTags.map((t) => `- ${t}`).join("\n");
  const commentListText = batch.map((c, i) => `${i}: "${c.comment}"`).join("\n");

  const systemPrompt =
    `You are classifying quality-evaluator feedback comments from an evaluator called "${evaluatorName}" against a FIXED ` +
    "list of issue tags. For each numbered comment, decide which of the following tags genuinely apply. A comment may " +
    "match zero, one, or several tags:\n\n" +
    tagListText +
    `\n\nSpecial rule: the tag "${NO_ISSUES_TAG}" must be used ONLY when the comment says the code is correct/clean with ` +
    "nothing wrong - it must NEVER be combined with any other tag on the same comment. Only assign tags that genuinely " +
    "apply based on the comment text - do not force a match if nothing fits well; it's fine for a comment to get zero tags.";

  const classifyTool = {
    name: "classify_comments",
    description: "Record which fixed issue tags apply to each numbered comment.",
    input_schema: {
      type: "object",
      properties: {
        classifications: {
          type: "array",
          items: {
            type: "object",
            properties: {
              i: { type: "integer", description: "The comment's index number" },
              tags: {
                type: "array",
                items: { type: "string", enum: allTags },
                uniqueItems: true,
                description: "Tags that genuinely apply to this comment; empty array if none do",
              },
            },
            required: ["i", "tags"],
          },
        },
      },
      required: ["classifications"],
    },
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const message = await anthropic.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 4096,
        thinking: { type: "disabled" },
        system: systemPrompt,
        messages: [{ role: "user", content: commentListText }],
        tools: [classifyTool],
        tool_choice: { type: "tool", name: "classify_comments" },
      });
      const toolUse = message.content.find((b) => b.type === "tool_use");
      let classifications = toolUse?.input?.classifications;
      // Occasionally the model double-encodes: instead of the array directly, "classifications"
      // comes back as a JSON *string* whose content is the whole {"classifications": [...]} object
      // (or, less often, just the array) - re-parse and unwrap rather than treat it as a failure.
      if (typeof classifications === "string") {
        try {
          const reparsed = JSON.parse(classifications);
          classifications = Array.isArray(reparsed) ? reparsed : reparsed.classifications;
        } catch {
          // leave as-is; falls through to the isArray check below and gets retried
        }
      }
      if (Array.isArray(classifications)) {
        return classifications.map((entry) => {
          const mapped = (entry.tags ?? []).map((t) => {
            const canonical = matchTag(t);
            if (!canonical) console.warn(`    Unrecognized tag "${t}" (comment ${entry.i}) - dropped.`);
            return canonical;
          });
          return { i: entry.i, tags: [...new Set(mapped.filter(Boolean))] };
        });
      }
      console.warn(
        `  Batch classification attempt ${attempt}: classifications was not an array. Raw input: ${JSON.stringify(toolUse?.input)?.slice(0, 500)}`
      );
    } catch (err) {
      console.warn(`  Batch classification attempt ${attempt} failed (${err.message}).`);
    }
  }
  console.warn("  Batch classification failed after retries - skipping this batch.");
  return [];
}

async function processFixedTagEvaluator(evaluatorName, entries, tagFilePath) {
  const allTags = [...loadTagVocabulary(tagFilePath), NO_ISSUES_TAG];
  const deduped = dedupe(entries);
  const batches = chunk(deduped, 40);
  console.log(`Classifying ${deduped.length} distinct comments in ${batches.length} batch(es) of up to 40 against ${allTags.length} fixed tags...`);

  const tagTotals = new Map(); // tag -> weighted count
  const tagExamples = new Map(); // tag -> [comment entries]

  for (let b = 0; b < batches.length; b++) {
    console.log(`  Batch ${b + 1}/${batches.length}...`);
    const classifications = await classifyBatch(batches[b], allTags, evaluatorName);
    for (const { i, tags } of classifications) {
      const comment = batches[b][i];
      if (!comment) continue;
      let finalTags = tags;
      if (finalTags.includes(NO_ISSUES_TAG) && finalTags.length > 1) {
        finalTags = finalTags.filter((t) => t !== NO_ISSUES_TAG); // a real issue was also found - drop "no issues"
      }
      for (const tag of finalTags) {
        tagTotals.set(tag, (tagTotals.get(tag) ?? 0) + comment.count);
        if (!tagExamples.has(tag)) tagExamples.set(tag, []);
        tagExamples.get(tag).push(comment);
      }
    }
  }

  const sortedTags = [...tagTotals.entries()].sort((a, b) => b[1] - a[1]);
  const top15 = sortedTags.slice(0, 15);
  console.log(`\n${evaluatorName} tag counts (top 15):`);
  for (const [tag, count] of top15) console.log(`  ${count}\t${tag}`);

  return { top15, tagExamples, tagTotals, allTags, deduped };
}

// Shared paragraph-writing method for ALL evaluators: read the full deduplicated comment list
// and let Claude write freely, rather than being fed a pre-computed tag/theme summary. This is
// deliberately independent of however each evaluator's chart/CSV gets its numbers, so the two
// concerns (paragraph vs. structured tag data) can evolve separately.
const PARAGRAPH_SAMPLE_THRESHOLD = 300;

function sampleForParagraph(deduped) {
  if (deduped.length <= PARAGRAPH_SAMPLE_THRESHOLD) return deduped;
  const shuffled = [...deduped];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, PARAGRAPH_SAMPLE_THRESHOLD);
}

async function writeSummaryParagraph(deduped, evaluatorName) {
  if (deduped.length === 0) return "No non-perfect, commented scores this week.";

  const sample = sampleForParagraph(deduped);
  const commentList = [...sample]
    .sort((a, b) => b.count - a.count)
    .map((d) => `- "${d.comment}" (occurred ${d.count}x, avg score ${d.avgValue.toFixed(2)})`)
    .join("\n");
  const sampleNote =
    deduped.length > PARAGRAPH_SAMPLE_THRESHOLD
      ? ` Note: this is a random sample of ${PARAGRAPH_SAMPLE_THRESHOLD} of ${deduped.length} distinct comments this week (there were more than the ${PARAGRAPH_SAMPLE_THRESHOLD}-comment threshold for this prompt).`
      : "";

  const systemPrompt =
    `You analyze quality-evaluator feedback comments from "${evaluatorName}" about an AI assistant that helps build ` +
    "OpenFN workflows and job code. You will be given a deduplicated list of comments from non-perfect scores, each with " +
    "how many times an identical comment occurred and the average score attached to it." +
    sampleNote +
    " Write ONE paragraph (3-5 sentences) summarizing the most recurrent issues, citing rough frequency where useful. " +
    "Respond with plain text only - no JSON, no preamble, no markdown.";

  const message = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    thinking: { type: "disabled" },
    system: systemPrompt,
    messages: [{ role: "user", content: commentList }],
  });
  const textBlock = message.content.find((b) => b.type === "text");
  return (textBlock?.text ?? "").trim();
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
// 4. Per evaluator: fixed-tag classification (Code quality judge v5) or
//    every evaluator now uses this same fixed-tag pattern - anything without a tags file is
//    skipped with a warning rather than silently ignored.
// ============================================================
const results = {};
const dateRangeLabel = `${fromTimestamp.slice(0, 10)} to ${toTimestamp.slice(0, 10)}`;
const dateRangeSlug = `${fromTimestamp.slice(0, 10)}_to_${toTimestamp.slice(0, 10)}`;

for (const [evaluatorName, entries] of byEvaluator) {
  console.log(`\n=== ${evaluatorName} (${entries.length} comments) ===`);

  if (!FIXED_TAG_EVALUATORS[evaluatorName]) {
    console.warn(`  No tag vocabulary configured for "${evaluatorName}" - skipping.`);
    continue;
  }

  const tagFilePath = join(scriptDir, FIXED_TAG_EVALUATORS[evaluatorName]);
  const { top15, tagTotals, allTags, deduped } = await processFixedTagEvaluator(evaluatorName, entries, tagFilePath);
  const summary = await writeSummaryParagraph(deduped, evaluatorName);
  results[evaluatorName] = { commentCount: entries.length, summary };

  console.log(`\nSummary:\n${summary}`);

  if (top15.length) {
    const bars = top15.map(([label, count]) => ({ label, count, color: colorForTag(label) }));
    const svg = renderIssueFrequencySVG({ evaluatorName, dateRangeLabel, bars, totalCount: entries.length });
    const chartFileName = `chart-${slugify(evaluatorName)}-${dateRangeSlug}.svg`;
    writeFileSync(join(outDir, chartFileName), svg, "utf8");
    console.log(`Wrote tmp/Evaluator summaries/${chartFileName}`);
  }

  appendFixedTagCsvRow({
    csvFileName: `${slugify(evaluatorName)}-summary.csv`,
    allTags,
    tagTotals,
    totalCount: entries.length,
    fromDate: fromTimestamp.slice(0, 10),
    toDate: toTimestamp.slice(0, 10),
  });
}

const txtSections = Object.entries(results).map(
  ([name, r]) => `${name}\n${"-".repeat(name.length)}\n\n${r.summary}`
);
const txtFileName = `evaluator-comment-summaries-${dateRangeSlug}.txt`;
writeFileSync(join(outDir, txtFileName), txtSections.join("\n\n\n"), "utf8");
console.log(`\nWrote summaries for ${Object.keys(results).length} evaluator(s) to tmp/Evaluator summaries/${txtFileName}`);
