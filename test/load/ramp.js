import { completion, seededRandom } from './lib/gateway.js';
import { uniquePrompt } from './lib/prompts.js';

const STEP = Number(__ENV.STEP || 10);
const STEPS = Number(__ENV.STEPS || 8);
const STEP_DURATION = __ENV.STEP_DURATION || '20s';

// climbs until the gateway stops keeping up, the interesting output is the step
// where latency departs from flat rather than the peak number
const stages = [];
for (let i = 1; i <= STEPS; i += 1) {
  stages.push({ target: STEP * i, duration: STEP_DURATION });
}

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate: STEP,
      timeUnit: '1s',
      stages,
      preAllocatedVUs: 50,
      maxVUs: 400,
    },
  },
};

const rand = seededRandom(20260824 + Number(__VU || 1));

export default function () {
  completion(uniquePrompt(rand), {
    bypassCache: true,
    scenario: 'ramp',
  });
}
