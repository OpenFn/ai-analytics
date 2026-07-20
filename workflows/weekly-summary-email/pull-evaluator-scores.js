const now = new Date();
const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
const fromTimestamp = oneWeekAgo.toISOString();
const toTimestamp = now.toISOString();

fn(state =>{
    console.log(`Window: ${fromTimestamp} to ${toTimestamp}\n`);
    return {...state, fromTimestamp, toTimestamp}
});

langfuse(async (state, api) => {
  const { fromTimestamp, toTimestamp } = state;

  const allScores = [];
{
  let cursor;
  while (true) {
    const { data, meta } = await api.scoresV3.getManyV3({
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

  return { ...state, allScores };
});