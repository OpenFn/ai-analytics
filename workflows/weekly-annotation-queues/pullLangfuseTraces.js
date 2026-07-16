const SCORE_CONFIG_NAMES = [
  "Was agent response reasonable",
  "Code quality judge review",
  "Code style judge review",
  "Escalate for deeper review",
  "Comment",
];
const SCORE_NAME = "Code quality judge v5";

const randomWord = () => Math.random().toString(36).substring(2, 8);

const now = new Date();
const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
const fromTimestamp = oneWeekAgo.toISOString();
const toTimestamp = now.toISOString();
const QUEUE_NAME = `Code judge human review queue (${fromTimestamp.slice(0, 10)} to ${toTimestamp.slice(0, 10)}) ${randomWord()}`;

function toObservationMap(scores) {
  const map = new Map();
  for (const score of scores) {
    if (typeof score.value !== "number") continue;
    if (score.subject?.kind !== "observation") continue;
    const obsId = score.subject.id;
    const existing = map.get(obsId);
    if (!existing || new Date(score.timestamp) > new Date(existing.timestamp)) {
      map.set(obsId, {
        value: score.value,
        timestamp: score.timestamp,
        traceId: score.subject.traceId,
      });
    }
  }
  return map;
}

fn((state) => {
  console.log(`Window: ${fromTimestamp} to ${toTimestamp}\n`);
  return state;
});

langfuse(async (state, api) => {
  const { data } = await api.scoresV3.getManyV3({
    SCORE_NAME,
    fromTimestamp,
    toTimestamp,
    fields: "subject",
    limit: 100,
  });

  return { ...state, data , SCORE_NAME, fromTimestamp, toTimestamp, QUEUE_NAME, SCORE_CONFIG_NAMES };
});

fn((state) => {
  console.log(`Fetched ${state.data.length} "${SCORE_NAME}" scores in window`);
  const byObs = toObservationMap(state.data);
  console.log(
    `Observations with a "${SCORE_NAME}" score in window: ${byObs.size}`,
  );
  return { ...state, byObs: Object.fromEntries(byObs) };
});
