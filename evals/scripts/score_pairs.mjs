// computes the similarity for every pair in the dataset using the gateway's own
// embedding code path
//
// this imports the compiled worker rather than reimplementing it, so there is
// no second copy of the prefix, pooling and normalisation to drift
//
//   pnpm build && node evals/scripts/score_pairs.mjs

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONTRACT_VERSION = 1;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const dataDir = path.join(root, 'evals', 'data');

// the worker sets env.cacheDir to './.models', relative to the process cwd
process.chdir(root);

const workerPath = path.join(root, 'dist', 'cache', 'embedding.worker.js');
if (!existsSync(workerPath)) {
  console.error(`missing ${workerPath}, run pnpm build first`);
  process.exit(1);
}

const workerModule = await import(pathToFileURL(workerPath).href);
const embed = workerModule.default?.default ?? workerModule.default;
if (typeof embed !== 'function') {
  console.error('could not resolve the embed function from the compiled worker');
  process.exit(1);
}

// onnxruntime-node is a transitive dependency, so under pnpm it lives only in
// the virtual store. it is the single most important field in the provenance
// record, so resolving it falls back to the store rather than reporting unknown.
function readPackageVersion(name) {
  const candidates = [path.join(root, 'node_modules', name, 'package.json')];

  const store = path.join(root, 'node_modules', '.pnpm');
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      if (entry.startsWith(`${name}@`)) {
        candidates.push(path.join(store, entry, 'node_modules', name, 'package.json'));
      }
    }
  }

  for (const file of candidates) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')).version;
    } catch {
      continue;
    }
  }
  return 'unresolved';
}

const pairsPath = path.join(dataDir, 'pairs.jsonl');
const pairsRaw = readFileSync(pairsPath, 'utf8');
const pairs = pairsRaw
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const topics = JSON.parse(readFileSync(path.join(dataDir, 'topics.json'), 'utf8'));

// every base text appears in several pairs, embedding it once keeps the numbers
// identical across pairs instead of merely equal to float rounding
const texts = [...new Set(pairs.flatMap((pair) => [pair.left, pair.right]))];
console.log(`${pairs.length} pairs, ${texts.length} unique texts`);

const vectors = new Map();
const startedAt = Date.now();
for (const [index, text] of texts.entries()) {
  vectors.set(text, await embed({ text }));
  if ((index + 1) % 25 === 0) console.log(`  embedded ${index + 1}/${texts.length}`);
}
const elapsedMs = Date.now() - startedAt;

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const rows = pairs.map((pair) => ({
  pair,
  similarity: cosine(vectors.get(pair.left), vectors.get(pair.right)),
}));

const output = {
  contract_version: CONTRACT_VERSION,
  provenance: {
    model: 'Xenova/multilingual-e5-small',
    dtype: 'q8',
    runtime: '@huggingface/transformers on onnxruntime-node',
    runtime_version: `transformers ${readPackageVersion('@huggingface/transformers')}, onnxruntime-node ${readPackageVersion('onnxruntime-node')}, node ${process.version}`,
    // the caller sets no level, so this is whatever onnxruntime-node defaults
    // to. asserting a value here would be a guess
    graph_optimization: 'unspecified by caller, onnxruntime-node default',
    prefix: 'query: ',
    pooling: 'mean',
    normalized: true,
    generated_at: new Date().toISOString(),
    dataset_version: topics.version,
    dataset_sha256: createHash('sha256').update(pairsRaw).digest('hex'),
  },
  rows,
};

const outPath = path.join(dataDir, 'similarities.json');
writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
console.log(`wrote ${rows.length} rows to ${outPath} in ${(elapsedMs / 1000).toFixed(1)}s`);

// the vectors go out separately because asking whether language is recoverable
// from the embedding needs the embedding, and similarities alone cannot answer it
const languageOf = new Map();
for (const pair of pairs) {
  languageOf.set(pair.left, pair.left_lang);
  languageOf.set(pair.right, pair.right_lang);
}

const vectorsPath = path.join(dataDir, 'vectors.json');
writeFileSync(
  vectorsPath,
  JSON.stringify(
    {
      contract_version: CONTRACT_VERSION,
      provenance: output.provenance,
      dimensions: vectors.get(texts[0]).length,
      rows: texts.map((text) => ({
        text,
        lang: languageOf.get(text),
        vector: vectors.get(text).map((value) => Number(value.toFixed(6))),
      })),
    },
    null,
    2,
  ) + '\n',
);
console.log(`wrote ${texts.length} vectors to ${vectorsPath}`);
