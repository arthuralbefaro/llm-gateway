/**
 * Models grouped by what they can be substituted with.
 *
 * The map is explicit rather than inferred. A name heuristic breaks the day a
 * vendor renames a model, and a price heuristic conflates cost with capability,
 * so a cheap new model would silently outrank a strong old one and a price
 * change would quietly reroute traffic. Substitutability is a product judgement
 * about acceptable answers, not something to derive from a string or a number.
 *
 * The cost is that a model with no entry has no equivalents and therefore no
 * cross-model fallback. That is the right failure mode: no substitution is
 * better than a substitution nobody chose.
 */
const TIERS: string[][] = [
  ['gpt-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-fable-5'],
  ['gpt-4.1', 'gpt-4o', 'claude-sonnet-5', 'claude-sonnet-4-6'],
  ['gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini', 'claude-haiku-4-5'],
  ['gpt-5-nano', 'gpt-4.1-nano'],
  ['local-small', 'local-large'],
];

const EQUIVALENTS = new Map<string, string[]>();
for (const tier of TIERS) {
  for (const model of tier) {
    EQUIVALENTS.set(
      model,
      tier.filter((candidate) => candidate !== model),
    );
  }
}

/**
 * Returns the models that may answer in place of the requested one, in the
 * order they should be tried. The requested model is not included.
 */
export function equivalentModels(model: string): string[] {
  return EQUIVALENTS.get(model) ?? [];
}
