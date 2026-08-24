// reproduction harness for ADR 0007. embeds the parity texts through the
// gateway's own runtime and dumps the vectors, so a second implementation can be
// checked against what the gateway actually computes.
//
// the python half that consumed this was deleted on purpose: the suite no longer
// embeds outside node, and the environment has no onnxruntime installed. this is
// kept because anyone repeating that comparison from another runtime needs the
// reference side of it.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync } from 'node:fs';
import { pipeline, env } from '@huggingface/transformers';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
env.cacheDir = path.join(root, '.models');

const texts = JSON.parse(
  readFileSync(path.join(here, 'parity-texts.json'), 'utf8'),
);

const extractor = await pipeline(
  'feature-extraction',
  'Xenova/multilingual-e5-small',
  { dtype: 'q8' },
);

const vectors = [];
for (const text of texts) {
  const out = await extractor(`query: ${text}`, {
    pooling: 'mean',
    normalize: true,
  });
  vectors.push(Array.from(out.data, Number));
}

writeFileSync(
  path.join(here, 'parity-node.json'),
  JSON.stringify({ texts, vectors }),
);
console.log(`embedded ${texts.length} texts through transformers.js`);
