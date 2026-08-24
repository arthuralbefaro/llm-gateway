import { sleep } from 'k6';
import { completion, seededRandom } from './lib/gateway.js';
import { drawPrompt, warmPool } from './lib/prompts.js';

// declared target, the report states the measured rate beside it
const TARGET_HIT_RATE = Number(__ENV.TARGET_HIT_RATE || 0);
const BYPASS_CACHE = TARGET_HIT_RATE === 0;
const RATE = Number(__ENV.RATE || 20);
const DURATION = __ENV.DURATION || '60s';

export const options = {
  scenarios: {
    constant: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Number(__ENV.VUS || 40),
      maxVUs: Number(__ENV.MAX_VUS || 200),
    },
  },
  thresholds: {
    // deliberately loose, the run is meant to find where it breaks rather than
    // to pass or fail
    http_req_failed: ['rate<0.5'],
  },
};

// the pool is seeded identically in every vu on purpose, a per vu pool means
// nothing repeats across vus and the measured rate lands far under the target
const pool = TARGET_HIT_RATE > 0 ? warmPool(20, seededRandom(1729)) : [];
const rand = seededRandom(20260824 + Number(__VU || 1));

export default function () {
  completion(drawPrompt(pool, TARGET_HIT_RATE, rand), {
    bypassCache: BYPASS_CACHE,
    scenario: `constant-hit${TARGET_HIT_RATE}`,
  });
  sleep(0.001);
}
