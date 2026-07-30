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

const SCORE_CONFIG_NAMES = ["Was agent response reasonable", "General red flag judge review", "Comment", "Escalate for deeper review"];
const SCORE_NAME = "General red flag judge v2";
const LOWEST_COUNT = 8;
const HIGHEST_COUNT = 3;
const RANDOM_COUNT = 4;

const now = new Date();
const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
const fromTimestamp = oneWeekAgo.toISOString();
const toTimestamp = now.toISOString();
const QUEUE_NAME = "Red flag judge human review queue";
console.log(`Window: ${fromTimestamp} to ${toTimestamp}\n`);

// ============================================================
// 1. Pull every "General red flag judge v2" score in the window
// ============================================================
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

// observationId -> { value, timestamp }, keeping the most recent score per observation
function toObservationMap(scores) {
  const map = new Map();
  for (const s of scores) {
    if (typeof s.value !== "number") continue;
    if (s.subject?.kind !== "observation") continue;
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

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const scores = await fetchScores(SCORE_NAME);
const byObs = toObservationMap(scores);
console.log(`Observations with a "${SCORE_NAME}" score in window: ${byObs.size}`);

// ============================================================
// 2. Select 8 lowest + 3 highest + 4 random from whatever remains
// ============================================================
const selected = new Map(); // observationId -> reasons[]
function flag(observationId, reason) {
  if (!observationId) return;
  if (!selected.has(observationId)) selected.set(observationId, []);
  selected.get(observationId).push(reason);
}

for (let i = 0; i < LOWEST_COUNT; i++) {
  const pick = pickExtreme(byObs, selected, "low");
  if (pick) flag(pick[0], `low ${SCORE_NAME} (${pick[1].value})`);
}
for (let i = 0; i < HIGHEST_COUNT; i++) {
  const pick = pickExtreme(byObs, selected, "high");
  if (pick) flag(pick[0], `high ${SCORE_NAME} (${pick[1].value})`);
}

const remaining = [...byObs.entries()].filter(([obsId]) => !selected.has(obsId));
const randomPicks = shuffle(remaining).slice(0, RANDOM_COUNT);
for (const [obsId, info] of randomPicks) {
  flag(obsId, `random pick (${SCORE_NAME} ${info.value})`);
}

console.log(`\nObservations selected: ${selected.size} (target up to ${LOWEST_COUNT + HIGHEST_COUNT + RANDOM_COUNT}: ${LOWEST_COUNT} low + ${HIGHEST_COUNT} high + ${RANDOM_COUNT} random)`);
for (const [id, reasons] of selected) console.log(`  - ${id}: ${reasons.join(", ")}`);

if (selected.size === 0) {
  console.log("\nNothing to add - skipping queue creation.");
  process.exit(0);
}

// ============================================================
// 3. Find score configs, then find-or-create the queue, then add the observations
// ============================================================
const { data: configs } = await langfuse.api.scoreConfigs.get({ limit: 100 });
const configByName = new Map(configs.map((c) => [c.name, c]));
const scoreConfigIds = [];
for (const name of SCORE_CONFIG_NAMES) {
  const config = configByName.get(name);
  if (!config) throw new Error(`Score config "${name}" not found.`);
  scoreConfigIds.push(config.id);
}
console.log(`\nResolved ${scoreConfigIds.length} score configs.`);

// The queue has a fixed name now (no date range) - reuse it across runs instead of
// creating a new one every week. listQueues has no server-side name filter, so we
// page through everything and match by name client-side.
async function findQueueByName(name) {
  let page = 1;
  const limit = 100;
  while (true) {
    const result = await withRetry(() => langfuse.api.annotationQueues.listQueues({ page, limit }), `annotationQueues.listQueues page ${page}`);
    if (!result) return null;
    const match = result.data.find((q) => q.name === name);
    if (match) return match;
    if (result.data.length === 0 || page * limit >= result.meta.totalItems) return null;
    page++;
  }
}

let queue = await findQueueByName(QUEUE_NAME);
if (queue) {
  console.log(`Found existing queue: id=${queue.id} name=${queue.name}`);
} else {
  queue = await langfuse.api.annotationQueues.createQueue({
    name: QUEUE_NAME,
    description: `Ongoing human review sample by "${SCORE_NAME}" score, ${LOWEST_COUNT} lowest + ${HIGHEST_COUNT} highest + ${RANDOM_COUNT} random added each run.`,
    scoreConfigIds,
  });
  console.log(`Created queue: id=${queue.id} name=${queue.name}`);
}

// Skip anything already sitting in the queue from a previous run, so re-running
// (or overlapping 7-day windows) can't add the same observation twice.
async function fetchExistingObjectIds(queueId) {
  const ids = new Set();
  let page = 1;
  const limit = 100;
  while (true) {
    const result = await withRetry(() => langfuse.api.annotationQueues.listQueueItems(queueId, { page, limit }), `annotationQueues.listQueueItems page ${page}`);
    if (!result) break;
    for (const item of result.data) ids.add(item.objectId);
    if (result.data.length === 0 || page * limit >= result.meta.totalItems) break;
    page++;
  }
  return ids;
}

const existingObjectIds = await fetchExistingObjectIds(queue.id);
console.log(`Queue already has ${existingObjectIds.size} item(s).`);

let added = 0;
let skipped = 0;
for (const [observationId, reasons] of selected) {
  if (existingObjectIds.has(observationId)) {
    console.log(`Skipped ${observationId} (${reasons.join(", ")}) - already in queue`);
    skipped++;
    continue;
  }
  const item = await langfuse.api.annotationQueues.createQueueItem(queue.id, {
    objectId: observationId,
    objectType: "OBSERVATION",
  });
  console.log(`Added ${observationId} (${reasons.join(", ")}) -> item ${item.id}`);
  added++;
}

console.log(`\nDone. ${added} observation(s) added to "${QUEUE_NAME}" (${skipped} already present, skipped).`);
