// proves the generator produces prompts an embedding sees as unrelated
//
// a load scenario that assumes its prompts miss the cache without measuring it
// is the failure described in docs/adr/0005, so this runs the real model and
// reports the fraction of pairs that would have hit

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline, env } from '@huggingface/transformers';
import { uniquePrompt, COMBINATIONS, TOPIC_COUNT } from './lib/prompts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
env.cacheDir = path.join(here, '..', '..', '.models');

const THRESHOLD = Number(process.argv[2] ?? 0.95);
const SAMPLE = Number(process.argv[3] ?? 120);

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

function mulberry32(seed) {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260824);
const extractor = await pipeline(
  'feature-extraction',
  'Xenova/multilingual-e5-small',
  { dtype: 'q8' },
);

const prompts = [];
const seen = new Set();
while (prompts.length < SAMPLE) {
  const prompt = uniquePrompt(rand).toLowerCase();
  if (!seen.has(prompt)) {
    seen.add(prompt);
    prompts.push(prompt);
  }
}

const vectors = [];
for (const prompt of prompts) {
  const out = await extractor(`query: ${prompt}`, {
    pooling: 'mean',
    normalize: true,
  });
  vectors.push(Array.from(out.data, Number));
}

let pairs = 0;
let above = 0;
let max = 0;
let sum = 0;
let worst = ['', ''];

for (let i = 0; i < vectors.length; i += 1) {
  for (let j = i + 1; j < vectors.length; j += 1) {
    const similarity = cosine(vectors[i], vectors[j]);
    pairs += 1;
    sum += similarity;
    if (similarity > max) {
      max = similarity;
      worst = [prompts[i], prompts[j]];
    }
    if (similarity >= THRESHOLD) above += 1;
  }
}

console.log(`vocabulary      : ${TOPIC_COUNT} topics, ${COMBINATIONS} combinations`);
console.log(`sampled prompts : ${prompts.length} distinct`);
console.log(`pairs compared  : ${pairs}`);
console.log(`threshold       : ${THRESHOLD}`);
console.log(`mean similarity : ${(sum / pairs).toFixed(4)}`);
console.log(`max similarity  : ${max.toFixed(4)}`);
console.log(`pairs >= thresh : ${above} (${((above / pairs) * 100).toFixed(3)}%)`);
console.log(`closest pair    : "${worst[0]}"`);
console.log(`                : "${worst[1]}"`);

const rate = above / pairs;
console.log(
  `\nunintended hit rate from entropy alone: ${(rate * 100).toFixed(3)}%`,
);
console.log(
  'entropy is the dial, cache:false is the guarantee, see docs/adr/0005',
);

// a percent of accidental hits would drown a scenario targeting a low rate
if (rate > 0.01) {
  console.log('VERDICT: too leaky to use as a dial');
  process.exitCode = 1;
} else {
  console.log('VERDICT: usable as a dial');
}
