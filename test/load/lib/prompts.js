// prompt generation for load scenarios
//
// entropy here is semantic, not lexical. a counter or a nonce appended to one
// sentence produces distinct strings whose embeddings sit far above the cache
// threshold, so the traffic silently becomes cache hits and the scenario
// measures the wrong layer. see docs/adr/0005

const TOPICS = [
  'photosynthesis in desert plants',
  'the collapse of the bronze age',
  'how sourdough starters ferment',
  'tidal locking of moons',
  'the invention of double entry bookkeeping',
  'antibiotic resistance in hospitals',
  'the rules of shogi',
  'volcanic soil fertility',
  'medieval guild apprenticeships',
  'error correcting codes in storage',
  'the migration of arctic terns',
  'baroque counterpoint',
  'desalination by reverse osmosis',
  'the history of the shipping container',
  'sleep cycles in marine mammals',
  'glacial moraine formation',
  'the economics of rent control',
  'silk production in ancient china',
  'radio propagation in the ionosphere',
  'coffee leaf rust epidemics',
  'the design of suspension bridges',
  'lactose tolerance in adult humans',
  'the printing press and literacy',
  'coral bleaching thresholds',
  'inventory turnover in retail',
  'the physics of curveballs',
  'peat bog preservation of bodies',
  'zoning laws and housing supply',
  'the evolution of flightless birds',
  'cryptographic hash collisions',
  'monsoon formation over india',
  'the great emu war',
  'lithium extraction from brine',
  'byzantine mosaic techniques',
  'circadian rhythms in plants',
  'the standardisation of railway gauges',
  'mycorrhizal networks in forests',
  'insurance underwriting cycles',
  'the acoustics of concert halls',
  'nitrogen fixation by legumes',
  'the domestication of horses',
  'submarine cable repair',
  'enzyme kinetics at low temperature',
  'the abolition of the slave trade',
  'urban heat island effects',
  'the manufacture of window glass',
  'birdsong dialects by region',
  'container ship routing in ice',
  'the chemistry of fireworks',
  'pension fund duration matching',
];

const ANGLES = [
  'explain the main mechanism behind',
  'what are the practical consequences of',
  'summarise the current understanding of',
  'describe the historical development of',
  'what commonly goes wrong with',
  'compare two competing explanations for',
  'what would change if we could measure',
  'outline the economics of',
  'what does the evidence say about',
  'describe an experiment that would test',
];

// a trailing clause varies the surface without moving the embedding, and two
// prompts sharing a topic landed at 0.96 when only the clause differed, so the
// entropy has to come from pairing two unrelated topics instead

function pick(list, rand) {
  return list[Math.floor(rand() * list.length)];
}

// the angle barely moves the embedding: the same topic pair under two angles
// measured 0.9742, so the pair itself is the unit of entropy and each one is
// spent once. one set per vu, since k6 gives every vu its own module instance
const usedPairs = new Set();

/**
 * Builds a prompt whose meaning is unrelated to the previous one.
 *
 * Two distinct topics are paired, because the topic is what an embedding reads
 * and one topic alone runs out after fifty prompts. Pairing turns fifty topics
 * into roughly twelve hundred combinations that are semantically apart rather
 * than lexically apart.
 */
export function uniquePrompt(rand) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const a = pick(TOPICS, rand);
    const b = pick(TOPICS, rand);
    if (a === b) {
      continue;
    }
    // ordered canonically, because "a relates to b" and "b relates to a" mean
    // the same thing and measured 0.9964 against each other
    const [first, second] = a < b ? [a, b] : [b, a];
    const key = `${first}|${second}`;
    if (usedPairs.has(key)) {
      continue;
    }
    usedPairs.add(key);
    return `${pick(ANGLES, rand)} ${first}, and how it relates to ${second}?`;
  }
  // the pair space is exhausted, so this run has outgrown the vocabulary and
  // the caller must rely on the cache opt out rather than on entropy
  return `${pick(ANGLES, rand)} ${pick(TOPICS, rand)}, and how it relates to ${pick(TOPICS, rand)}?`;
}

export function exhausted() {
  return usedPairs.size >= (TOPICS.length * (TOPICS.length - 1)) / 2;
}

/**
 * A small pool of prompts that repeat, used to reach a target hit rate.
 */
export function warmPool(size, rand) {
  const pool = [];
  for (let i = 0; i < size; i += 1) {
    pool.push(uniquePrompt(rand));
  }
  return pool;
}

/**
 * Draws a prompt for a scenario targeting `hitRate` of repeated traffic.
 *
 * A repeat is only a likely hit once it has been served and stored, so early
 * iterations of a run pull the measured rate below the target. The report
 * states the measured rate rather than the target for exactly that reason.
 */
export function drawPrompt(pool, hitRate, rand) {
  if (pool.length > 0 && rand() < hitRate) {
    return pool[Math.floor(rand() * pool.length)];
  }
  return uniquePrompt(rand);
}

export const TOPIC_COUNT = TOPICS.length;
export const COMBINATIONS =
  ((TOPICS.length * (TOPICS.length - 1)) / 2) * ANGLES.length;
