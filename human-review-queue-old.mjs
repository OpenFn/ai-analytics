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

const QUEUE_NAME = "Human review of all three evaluator judges";
const SCORE_CONFIG_NAMES = [
  "Human review of Code quality judge",
  "Code quality human score",
  "Human review of Code judge - style",
  "Code style human score",
  "Human review of workflow judge",
  "Workflow human score",
  "HumanReview of general openfn judge",
  "HumanReview of OpenFN quality",
  "Comments",
];

const now = new Date();
const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
const fromTimestamp = oneWeekAgo.toISOString();
const toTimestamp = now.toISOString();
console.log(`Window: ${fromTimestamp} to ${toTimestamp}\n`);

// ============================================================
// Helpers
// ============================================================
async function fetchTraceIds(name) {
  const filter = JSON.stringify([{ type: "string", column: "name", operator: "=", value: name }]);
  const ids = new Set();
  let page = 1;
  const limit = 100;
  while (true) {
    const result = await withRetry(
      () => langfuse.api.trace.list({ page, limit, filter, fromTimestamp, toTimestamp, fields: "core" }),
      `trace.list(${name}) page ${page}`
    );
    if (!result) break;
    for (const t of result.data) ids.add(t.id);
    if (result.data.length === 0 || page * limit >= result.meta.totalItems) break;
    page++;
  }
  return ids;
}

async function fetchScores(name) {
  const scores = [];
  let cursor;
  while (true) {
    const result = await withRetry(
      () => langfuse.api.scoresV3.getManyV3({ name, fromTimestamp, toTimestamp, fields: "subject", limit: 100, cursor }),
      `scoresV3.getManyV3(${name}) cursor=${cursor ?? "start"}`
    );
    if (!result) break;
    scores.push(...result.data);
    if (!result.meta.cursor) break;
    cursor = result.meta.cursor;
  }
  return scores;
}

// observationId -> { value, timestamp }, keeping the most recent score per observation,
// restricted to observations belonging to a trace in traceIdSet
function toObservationMap(scores, traceIdSet) {
  const map = new Map();
  for (const s of scores) {
    if (typeof s.value !== "number") continue;
    if (s.subject?.kind !== "observation") continue;
    if (!traceIdSet.has(s.subject.traceId)) continue;
    const obsId = s.subject.id;
    const existing = map.get(obsId);
    if (!existing || new Date(s.timestamp) > new Date(existing.timestamp)) {
      map.set(obsId, { value: s.value, timestamp: s.timestamp, traceId: s.subject.traceId });
    }
  }
  return map;
}

function pickExtreme(map, selected, direction) {
  const entries = [...map.entries()].filter(([obsId]) => !selected.has(obsId));
  if (entries.length === 0) return null;
  entries.sort((a, b) => (direction === "low" ? a[1].value - b[1].value : b[1].value - a[1].value));
  return entries[0]; // [observationId, {value, timestamp, traceId}]
}

// ============================================================
// 1. job_chat: 5 lowest + 5 highest "Code quality judge v5"
// ============================================================
console.log("=== job_chat ===");
const jobChatTraceIds = await fetchTraceIds("job_chat");
const codeQualityV5Scores = await fetchScores("Code quality judge v5");
const codeQualityByObs = toObservationMap(codeQualityV5Scores, jobChatTraceIds);
console.log(`job_chat traces in window: ${jobChatTraceIds.size}, scored observations: ${codeQualityByObs.size}`);

const jobChatSelected = new Map(); // observationId -> reasons[]
function flag(map, observationId, reason) {
  if (!observationId) return;
  if (!map.has(observationId)) map.set(observationId, []);
  map.get(observationId).push(reason);
}

for (let i = 0; i < 5; i++) {
  const pick = pickExtreme(codeQualityByObs, jobChatSelected, "low");
  if (pick) flag(jobChatSelected, pick[0], `low Code quality judge v5 (${pick[1].value})`);
}
for (let i = 0; i < 5; i++) {
  const pick = pickExtreme(codeQualityByObs, jobChatSelected, "high");
  if (pick) flag(jobChatSelected, pick[0], `high Code quality judge v5 (${pick[1].value})`);
}
console.log(`job_chat observations selected: ${jobChatSelected.size} (target 10)`);
for (const [id, reasons] of jobChatSelected) console.log(`  - ${id}: ${reasons.join(", ")}`);

// ============================================================
// 2. workflow_chat / global_chat: 5 each, per the agreed 5-slot rule
// ============================================================
const workflowV3Scores = await fetchScores("Workflow quality judge v3");
const generalV3Scores = await fetchScores("General openfn quality judge v3");

async function selectForType(typeName) {
  console.log(`\n=== ${typeName} ===`);
  const traceIds = await fetchTraceIds(typeName);
  const workflowByObs = toObservationMap(workflowV3Scores, traceIds);
  const generalByObs = toObservationMap(generalV3Scores, traceIds);
  console.log(`${typeName} traces in window: ${traceIds.size}, Workflow v3 scored: ${workflowByObs.size}, General v3 scored: ${generalByObs.size}`);

  const selected = new Map();
  const low1 = pickExtreme(workflowByObs, selected, "low");
  if (low1) flag(selected, low1[0], `lowest Workflow quality judge v3 (${low1[1].value})`);
  const high1 = pickExtreme(workflowByObs, selected, "high");
  if (high1) flag(selected, high1[0], `highest Workflow quality judge v3 (${high1[1].value})`);
  const lowG = pickExtreme(generalByObs, selected, "low");
  if (lowG) flag(selected, lowG[0], `lowest General openfn quality judge v3 (${lowG[1].value})`);
  const highG = pickExtreme(generalByObs, selected, "high");
  if (highG) flag(selected, highG[0], `highest General openfn quality judge v3 (${highG[1].value})`);
  const low2 = pickExtreme(workflowByObs, selected, "low");
  if (low2) flag(selected, low2[0], `2nd-lowest Workflow quality judge v3 (${low2[1].value})`);

  console.log(`${typeName} observations selected: ${selected.size} (target 5)`);
  for (const [id, reasons] of selected) console.log(`  - ${id}: ${reasons.join(", ")}`);
  return selected;
}

const workflowChatSelected = await selectForType("workflow_chat");
const globalChatSelected = await selectForType("global_chat");

// ============================================================
// 3. Merge everything, find score configs, create the queue
// ============================================================
const allSelected = new Map([...jobChatSelected, ...workflowChatSelected, ...globalChatSelected]);
console.log(`\nTotal observations to add: ${allSelected.size}`);

if (allSelected.size === 0) {
  console.log("Nothing selected - aborting.");
  process.exit(0);
}

const { data: configs } = await langfuse.api.scoreConfigs.get({ limit: 100 });
const configByName = new Map(configs.map((c) => [c.name, c]));
const scoreConfigIds = [];
for (const name of SCORE_CONFIG_NAMES) {
  const config = configByName.get(name);
  if (!config) throw new Error(`Score config "${name}" not found.`);
  scoreConfigIds.push(config.id);
}
console.log(`\nResolved ${scoreConfigIds.length} score configs.`);

const queue = await langfuse.api.annotationQueues.createQueue({
  name: QUEUE_NAME,
  description: `Human review sample from the last 7 days (${fromTimestamp} to ${toTimestamp}): 10 job_chat (Code quality judge v5 extremes), 5 workflow_chat and 5 global_chat (Workflow quality judge v3 / General openfn quality judge v3 extremes).`,
  scoreConfigIds,
});
console.log(`Created queue: id=${queue.id} name=${queue.name}`);

for (const [observationId, reasons] of allSelected) {
  const item = await langfuse.api.annotationQueues.createQueueItem(queue.id, {
    objectId: observationId,
    objectType: "OBSERVATION",
  });
  console.log(`Added ${observationId} (${reasons.join(", ")}) -> item ${item.id}`);
}

console.log(`\nDone. ${allSelected.size} observation(s) added to "${QUEUE_NAME}".`);
