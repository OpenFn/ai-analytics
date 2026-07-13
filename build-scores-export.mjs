import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LangfuseClient } from "@langfuse/client";

const langfuse = new LangfuseClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// ============================================================
// Step 1: real conversation traces, full content
// ============================================================
const REAL_TRACE_NAMES = ["job_chat", "workflow_chat", "global_chat", "anthropic.chat"];
const realTraces = [];

for (const name of REAL_TRACE_NAMES) {
  const filter = JSON.stringify([{ type: "string", column: "name", operator: "=", value: name }]);
  let page = 1;
  const limit = 10;
  let totalItems = null; // last known total for this name, from any successful page
  const maxPages = 500; // safety cap in case the API never succeeds even once
  while (page <= maxPages) {
    const result = await withRetry(
      () => langfuse.api.trace.list({ page, limit, filter }),
      `trace.list(${name}) page ${page}`
    );
    if (result) {
      const { data, meta } = result;
      totalItems = meta.totalItems;
      realTraces.push(...data);
      console.log(`${name}: page ${page} (+${data.length}), running total ${realTraces.length}`);
      if (data.length === 0 || page * limit >= totalItems) break;
    } else {
      console.warn(`${name}: page ${page} permanently failed - up to ${limit} traces on this page will be missing.`);
      if (totalItems !== null && page * limit >= totalItems) break;
    }
    page++;
    await sleep(300);
  }
}
console.log(`\nTotal real conversation traces: ${realTraces.length}\n`);

const traceById = new Map(realTraces.map((t) => [t.id, t]));
const realTraceIds = new Set(realTraces.map((t) => t.id));

// ============================================================
// Step 2: all scores, bulk cursor pagination
// ============================================================
const allScores = [];
{
  let cursor;
  while (true) {
    const result = await withRetry(
      () => langfuse.api.scoresV3.getManyV3({ limit: 100, cursor, fields: "details,subject" }),
      `scoresV3.getManyV3 cursor=${cursor ?? "start"}`
    );
    if (!result) break;
    allScores.push(...result.data);
    if (!result.meta.cursor) break;
    cursor = result.meta.cursor;
  }
}
console.log(`Total scores fetched: ${allScores.length}`);

function subjectTraceId(score) {
  if (!score.subject) return undefined;
  if (score.subject.kind === "trace" || score.subject.kind === "observation") {
    return score.subject.traceId ?? score.subject.id;
  }
  return undefined;
}
function subjectObservationId(score) {
  return score.subject?.kind === "observation" ? score.subject.id : null;
}

const liveScores = [];
const batchScores = [];
for (const s of allScores) {
  const traceId = subjectTraceId(s);
  if (traceId && realTraceIds.has(traceId)) {
    s._resolvedTraceId = traceId;
    s._resolvedObservationId = subjectObservationId(s);
    liveScores.push(s);
  } else if (traceId) {
    batchScores.push(s);
  }
}
console.log(`Live scores (direct match): ${liveScores.length}`);
console.log(`Batch/experiment scores to resolve: ${batchScores.length}`);

// ============================================================
// Step 3: resolve batch scores -> dataset item -> real trace/observation
// ============================================================
const datasetItemToReal = new Map(); // datasetItemId -> { realTraceId, realObservationId }
const runItemTraceToDatasetItem = new Map(); // dataset-run-item traceId -> datasetItemId

{
  const datasets = [];
  let page = 1;
  while (true) {
    const result = await withRetry(() => langfuse.api.datasets.list({ page, limit: 100 }), `datasets.list page ${page}`);
    if (!result) break;
    datasets.push(...result.data);
    if (result.data.length === 0 || page * 100 >= result.meta.totalItems) break;
    page++;
  }
  console.log(`Found ${datasets.length} datasets`);

  for (const ds of datasets) {
    // all items in this dataset, to learn each item's real source trace/observation
    let ipage = 1;
    while (true) {
      const result = await withRetry(
        () => langfuse.api.datasetItems.list({ datasetName: ds.name, page: ipage, limit: 100 }),
        `datasetItems.list(${ds.name}) page ${ipage}`
      );
      if (!result) break;
      for (const item of result.data) {
        const realTraceId = item.input?.traceId;
        const realObservationId = item.input?.id ?? null;
        if (realTraceId) datasetItemToReal.set(item.id, { realTraceId, realObservationId });
      }
      if (result.data.length === 0 || ipage * 100 >= result.meta.totalItems) break;
      ipage++;
    }

    // all runs in this dataset, to learn each run-item's dataset item
    let rpage = 1;
    const runs = [];
    while (true) {
      const result = await withRetry(
        () => langfuse.api.datasets.getRuns(ds.name, { page: rpage, limit: 100 }),
        `datasets.getRuns(${ds.name}) page ${rpage}`
      );
      if (!result) break;
      runs.push(...result.data);
      if (result.data.length === 0 || rpage * 100 >= result.meta.totalItems) break;
      rpage++;
    }
    for (const run of runs) {
      const runWithItems = await withRetry(
        () => langfuse.api.datasets.getRun(ds.name, run.name),
        `datasets.getRun(${ds.name}, ${run.name})`
      );
      if (!runWithItems) continue;
      for (const item of runWithItems.datasetRunItems) {
        runItemTraceToDatasetItem.set(item.traceId, item.datasetItemId);
      }
    }
  }
}
console.log(`Dataset items resolved to real conversations: ${datasetItemToReal.size}`);
console.log(`Dataset-run-item traces mapped to dataset items: ${runItemTraceToDatasetItem.size}`);

let resolvedBatchCount = 0;
for (const s of batchScores) {
  const runTraceId = subjectTraceId(s);
  const datasetItemId = runItemTraceToDatasetItem.get(runTraceId);
  if (!datasetItemId) continue;
  const real = datasetItemToReal.get(datasetItemId);
  if (!real) continue;
  s._resolvedTraceId = real.realTraceId;
  s._resolvedObservationId = real.realObservationId;
  resolvedBatchCount++;
}
console.log(`Batch scores successfully resolved to a real conversation: ${resolvedBatchCount} of ${batchScores.length}\n`);

const resolvedScores = [...liveScores, ...batchScores.filter((s) => s._resolvedTraceId && realTraceIds.has(s._resolvedTraceId))];

// ============================================================
// Step 4: pivot into columns and write both CSVs
// ============================================================
const evaluatorNames = [...new Set(resolvedScores.map((s) => s.name))].sort();
console.log(`Distinct evaluators found: ${evaluatorNames.join(", ")}\n`);

const baseFields = ["id", "timestamp", "sessionId", "userId", "name", "latency", "totalCost", "input", "output"];
const baseHeaders = ["traceId", "timestamp", "sessionId", "userId", "name", "latencySeconds", "totalCostUsd", "input", "output"];
const scoreHeaders = evaluatorNames.flatMap((n) => [n, `${n}_comment`]);

function scoreCellsFor(scoresMap) {
  return evaluatorNames.flatMap((n) => {
    const sc = scoresMap[n];
    return [sc ? sc.value : "", sc ? sc.comment ?? "" : ""];
  });
}

// group scores by (traceId, observationId)
const byObsKey = new Map();
for (const s of resolvedScores) {
  const key = `${s._resolvedTraceId}::${s._resolvedObservationId ?? ""}`;
  if (!byObsKey.has(key)) {
    byObsKey.set(key, { traceId: s._resolvedTraceId, observationId: s._resolvedObservationId, scores: {} });
  }
  byObsKey.get(key).scores[s.name] = { value: s.value, comment: s.comment };
}

// group scores by traceId only (collapsed)
const byTrace = new Map();
for (const s of resolvedScores) {
  if (!byTrace.has(s._resolvedTraceId)) byTrace.set(s._resolvedTraceId, {});
  byTrace.get(s._resolvedTraceId)[s.name] = { value: s.value, comment: s.comment };
}

// --- by-observation file (traceId and observationId kept together up front) ---
{
  const restHeaders = baseHeaders.slice(1); // everything after traceId
  const restFields = baseFields.slice(1);
  const rows = [["traceId", "observationId", ...restHeaders, ...scoreHeaders].join(",")];
  const seenTraceIds = new Set();
  for (const group of byObsKey.values()) {
    const base = traceById.get(group.traceId);
    if (!base) continue;
    seenTraceIds.add(group.traceId);
    const row = [base.id, group.observationId ?? "", ...restFields.map((f) => base[f]), ...scoreCellsFor(group.scores)];
    rows.push(row.map(csvField).join(","));
  }
  for (const t of realTraces) {
    if (!seenTraceIds.has(t.id)) {
      const row = [t.id, "", ...restFields.map((f) => t[f]), ...scoreCellsFor({})];
      rows.push(row.map(csvField).join(","));
    }
  }
  const outUrl = new URL("langfuse_scores_by_observation.csv", import.meta.url);
  writeFileSync(outUrl, rows.join("\n"), "utf8");
  console.log(`Wrote ${rows.length - 1} rows to ${fileURLToPath(outUrl)}`);
}

// --- by-trace file (collapsed) ---
{
  const rows = [[...baseHeaders, ...scoreHeaders].join(",")];
  for (const t of realTraces) {
    const scoresMap = byTrace.get(t.id) ?? {};
    const row = [...baseFields.map((f) => t[f]), ...scoreCellsFor(scoresMap)];
    rows.push(row.map(csvField).join(","));
  }
  const outUrl = new URL("langfuse_scores_by_trace.csv", import.meta.url);
  writeFileSync(outUrl, rows.join("\n"), "utf8");
  console.log(`Wrote ${rows.length - 1} rows to ${fileURLToPath(outUrl)}`);
}
