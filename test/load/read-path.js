import { completion, seededRandom } from './lib/gateway.js';
import { uniquePrompt } from './lib/prompts.js';

// the default read path stopped embedding when semantic lookup became opt-in
// (adr 0010), and cache mode 'semantic' reproduces the old default exactly, so
// the same build measures before and after on the same machine
const MODE = __ENV.CACHE_MODE || 'default';
const RATE = Number(__ENV.RATE || 40);
const DURATION = __ENV.DURATION || '30s';

export const options = {
  scenarios: {
    read_path: {
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
    cacheMode: MODE === 'semantic' ? 'semantic' : undefined,
    scenario: `read-${MODE}`,
  });
}
