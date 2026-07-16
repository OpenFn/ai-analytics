langfuse(async (state, api) => {
  const { data: configs } = await api.scoreConfigs.get({ limit: 100 });

  return { ...state, configs };
});

fn((state) => {
  const { configs, SCORE_CONFIG_NAMES } = state;
  const configByName = new Map(configs.map((c) => [c.name, c]));
  const scoreConfigIds = [];
  for (const name of SCORE_CONFIG_NAMES) {
    const config = configByName.get(name);
    if (!config) throw new Error(`Score config "${name}" not found.`);
    scoreConfigIds.push(config.id);
  }
  console.log(`\nResolved ${scoreConfigIds.length} score configs.`);
  return { ...state, scoreConfigIds };
});

langfuse(async (state, api) => {
  const queue = await api.annotationQueues.createQueue({
    name: state.QUEUE_NAME,
    description: `Human review sample from the last 7 days (${state.fromTimestamp} to ${state.toTimestamp}): 5 lowest, 5 highest, and 10 randomly selected observations by "${state.SCORE_NAME}" score.`,
    scoreConfigIds: state.scoreConfigIds,
  });
  console.log(`Created queue: id=${queue.id} name=${queue.name}`);

  return { ...state, queue };
});

each(
  $.selected,
  langfuse(async (state, api) => {
    const item = await api.annotationQueues.createQueueItem(state.queue.id, {
      objectId: state.data.observationId,
      objectType: "OBSERVATION",
    });
    console.log(
      `Added ${state.data.observationId} (${state.data.reasons.join(", ")}) -> item ${item.id}`,
    );

    return state;
  }),
);
