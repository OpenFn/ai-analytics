fn((state) => {
  const byObs = new Map(Object.entries(state.byObs));
  const SCORE_NAME = state.SCORE_NAME;

  const selected = new Map(); // observationId -> reasons[]

  function flag(observationId, reason) {
    if (!observationId) return;
    if (!selected.has(observationId)) selected.set(observationId, []);
    selected.get(observationId).push(reason);
  }

  function pickExtreme(map, sel, direction) {
    const entries = [...map.entries()].filter(([obsId]) => !sel.has(obsId));
    if (entries.length === 0) return null;
    entries.sort((a, b) =>
      direction === "low" ? a[1].value - b[1].value : b[1].value - a[1].value
    );
    return entries[0];
  }

  function shuffle(array) {
    const copy = [...array];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  for (let i = 0; i < 5; i++) {
    const pick = pickExtreme(byObs, selected, "low");
    if (pick) flag(pick[0], `low ${SCORE_NAME} (${pick[1].value})`);
  }
  for (let i = 0; i < 5; i++) {
    const pick = pickExtreme(byObs, selected, "high");
    if (pick) flag(pick[0], `high ${SCORE_NAME} (${pick[1].value})`);
  }

  const remaining = [...byObs.entries()].filter(([obsId]) => !selected.has(obsId));
  const randomPicks = shuffle(remaining).slice(0, 10);
  for (const [obsId, info] of randomPicks) {
    flag(obsId, `random pick (${SCORE_NAME} ${info.value})`);
  }

  console.log(
    `\nObservations selected: ${selected.size} (target up to 20: 5 low + 5 high + 10 random)`
  );
  for (const [id, reasons] of selected)
    console.log(`  - ${id}: ${reasons.join(", ")}`);


  const selectedArray = [...selected.entries()].map(([observationId, reasons]) => ({
    observationId,
    reasons,
    ...byObs.get(observationId),
  }));

  return { ...state, selected: selectedArray };
});
