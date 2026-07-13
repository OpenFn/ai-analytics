import { readFileSync } from "node:fs";

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
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const text = readFileSync(new URL("langfuse_scores_by_observation.csv", import.meta.url), "utf8");
const rows = parseCsv(text);
const header = rows[0];
const nameIdx = header.indexOf("name");

const SCORE_COLUMNS = ["Code quality judge v3", "General openfn quality judge v2", "Workflow quality judge v2"];

const binEdges = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001]; // last edge nudged to include 1.0
function binIndex(v) {
  for (let i = 0; i < binEdges.length - 1; i++) {
    if (v >= binEdges[i] && v < binEdges[i + 1]) return i;
  }
  return binEdges.length - 2;
}

for (const scoreColumn of SCORE_COLUMNS) {
  const scoreIdx = header.indexOf(scoreColumn);
  console.log(`\n=== ${scoreColumn} ===`);
  if (scoreIdx === -1) {
    console.log("  column not found");
    continue;
  }

  const scoresByType = { job_chat: [], global_chat: [], workflow_chat: [] };
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < header.length) continue;
    const name = r[nameIdx];
    const scoreStr = r[scoreIdx];
    if (!(name in scoresByType)) continue;
    if (scoreStr === "" || scoreStr === undefined) continue;
    const score = Number(scoreStr);
    if (Number.isNaN(score)) continue;
    scoresByType[name].push(score);
  }

  for (const [name, scores] of Object.entries(scoresByType)) {
    console.log(`${name}: n=${scores.length}`);
    if (scores.length) {
      console.log(`  min=${Math.min(...scores)} max=${Math.max(...scores)} mean=${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(3)}`);
      const bins = new Array(binEdges.length - 1).fill(0);
      for (const v of scores) bins[binIndex(v)]++;
      console.log(`  bins (0.0-0.1 ... 0.9-1.0): ${bins.join(", ")}`);
    }
  }
}
