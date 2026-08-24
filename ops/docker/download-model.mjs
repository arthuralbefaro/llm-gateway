// bakes the embedding model into the image at build time, so the first boot of
// a fresh clone is not a silent 130 MB download plus 38 seconds of load with
// nothing in the logs explaining it
import { env, pipeline } from '@huggingface/transformers';

env.cacheDir = './.models';

const extractor = await pipeline(
  'feature-extraction',
  'Xenova/multilingual-e5-small',
  { dtype: 'q8' },
);

// one real embed proves the graph actually loads, a download alone would not
const out = await extractor('query: build-time smoke test', {
  pooling: 'mean',
  normalize: true,
});
if (out.data.length !== 384) {
  throw new Error(`expected 384 dimensions, got ${out.data.length}`);
}
console.log('model cached in .models, 384 dimensions verified');
