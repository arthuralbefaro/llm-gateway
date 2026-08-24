import { completion, seededRandom } from './lib/gateway.js';
import { uniquePrompt } from './lib/prompts.js';

// same load twice, once paying for an embedding on every store and once paying
// none, to attribute the saturation point rather than guess at it
const NO_EMBEDDING = __ENV.NO_EMBEDDING === 'true';
const RATE = Number(__ENV.RATE || 40);
const DURATION = __ENV.DURATION || '30s';

export const options = {
  scenarios: {
    isolate: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 60,
      maxVUs: 300,
    },
  },
};

const rand = seededRandom(20260824 + Number(__VU || 1));

export default function () {
  completion(uniquePrompt(rand), {
    bypassCache: !NO_EMBEDDING,
    temperature: NO_EMBEDDING ? 0.9 : undefined,
    scenario: NO_EMBEDDING ? 'no-embedding' : 'with-embedding',
  });
}
