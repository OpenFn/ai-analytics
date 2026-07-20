const systemPrompt =
  "You analyze quality-evaluator feedback comments about an AI assistant that helps build OpenFN workflows and job code. " +
  "You will be given a deduplicated list of comments from non-perfect scores by one evaluator, each with how many times " +
  "an identical comment occurred and the average score attached to it. Cluster them into recurring issue themes, then " +
  "write ONE paragraph (3-5 sentences) summarizing the most recurrent issues, citing rough frequency where useful. " +
  'Respond with ONLY valid JSON, no other text: {"themes": [{"label": string, "count": number, "example": string}], "summary": string}';

function dedupe(entries) {
  const map = new Map(); // comment -> { count, values }
  for (const { value, comment } of entries) {
    if (!map.has(comment)) map.set(comment, { count: 0, values: [] });
    const e = map.get(comment);
    e.count++;
    e.values.push(value);
  }
  return [...map.entries()].map(([comment, e]) => ({
    comment,
    count: e.count,
    avgValue: e.values.reduce((a, b) => a + b, 0) / e.values.length,
  }));
}

fn((state) => {
  const { fromTimestamp, toTimestamp, allScores } = state;
  const dateRangeLabel = `${fromTimestamp.slice(0, 10)} to ${toTimestamp.slice(0, 10)}`;
  const dateRangeSlug = `${fromTimestamp.slice(0, 10)}_to_${toTimestamp.slice(0, 10)}`;

  const byEvaluator = {}; // plain object (not Map) so it survives JSON serialization
  for (const score of allScores) {
    if (score.dataType !== "NUMERIC") continue;
    if (score.value === 1) continue; // perfect score - no signal
    if (!score.comment || !score.comment.trim()) continue;
    if (!byEvaluator[score.name]) byEvaluator[score.name] = [];
    byEvaluator[score.name].push({
      value: score.value,
      comment: score.comment.trim(),
    });
  }

  const evaluatorNames = Object.keys(byEvaluator);
  console.log(
    `\nEvaluators with non-perfect commented scores: ${evaluatorNames.length}`,
  );
  for (const name of evaluatorNames)
    console.log(`  - ${name}: ${byEvaluator[name].length} comments`);
  return {
    ...state,
    byEvaluator: Object.entries(byEvaluator),
    dateRangeLabel,
    dateRangeSlug,
  };
});

each($.byEvaluator, async (state) => {
  const { dateRangeLabel, dateRangeSlug } = state;
  const [evaluatorName, entries] = state.data;
  const deduped = dedupe(entries);
  console.log(
    `\n=== ${evaluatorName} (${entries.length} comments, ${deduped.length} distinct) ===`,
  );

  const commentList = deduped
    .sort((a, b) => b.count - a.count)
    .map(
      (d) =>
        `- "${d.comment}" (occurred ${d.count}x, avg score ${d.avgValue.toFixed(2)})`,
    )
    .join("\n");

  const newState = await prompt(commentList, {
    system: systemPrompt,
    model: "claude-sonnet-5",
    max_tokens: 4096,
  })(state);

  const textBlock = newState.data?.content?.find((b) => b.type === "text");
  const raw = (textBlock?.text ?? "")
    .trim()
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "");

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { parsed = { themes: [], summary: raw }; }

  for (const t of parsed.themes ?? [])
    console.log(`  - ${t.label} (x${t.count}): "${t.example}"`);
  console.log(`\nSummary:\n${parsed.summary}`);

  const results = { ...(state.results ?? {}), [evaluatorName]: {
    commentCount: entries.length,
    distinctCommentCount: deduped.length,
    ...parsed,
  }};

  return { ...newState, results };
});

fn((state) => {
  const { results, dateRangeLabel, dateRangeSlug } = state;
  const summaryText = Object.entries(results ?? {})
    .map(([name, r]) => `${name}\n${"-".repeat(name.length)}\n\n${r.summary}`)
    .join("\n\n\n");
  console.log(`\nBuilt summaries for ${Object.keys(results ?? {}).length} evaluator(s)`);
  return { ...state, summaryText, dateRangeLabel, dateRangeSlug };
});
