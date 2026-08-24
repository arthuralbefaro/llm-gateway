import { BreakerPolicy, CircuitBreaker } from './circuit-breaker';

const POLICY: BreakerPolicy = {
  failureRatio: 0.5,
  minimumVolume: 4,
  windowMs: 10_000,
  openMs: 5_000,
};

function breakerAt(clock: { now: number }): CircuitBreaker {
  return new CircuitBreaker('stub', POLICY, () => clock.now);
}

describe('CircuitBreaker', () => {
  it('starts closed and lets calls through', () => {
    const breaker = breakerAt({ now: 0 });

    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.snapshot().state).toBe('closed');
  });

  it('stays closed below the minimum volume however bad the ratio', () => {
    const breaker = breakerAt({ now: 0 });

    // the first request of the day failing must not take the provider out
    for (let i = 0; i < POLICY.minimumVolume - 1; i += 1) {
      breaker.recordFailure();
    }

    expect(breaker.snapshot().state).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('opens once the failure ratio is reached with enough volume', () => {
    const breaker = breakerAt({ now: 0 });

    for (let i = 0; i < 4; i += 1) {
      breaker.recordFailure();
    }

    expect(breaker.snapshot().state).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('stays closed when failures are a small share of a large volume', () => {
    const breaker = breakerAt({ now: 0 });

    for (let i = 0; i < 100; i += 1) {
      breaker.recordSuccess();
    }
    for (let i = 0; i < 5; i += 1) {
      breaker.recordFailure();
    }

    // five failures in a hundred is a different provider from five in five
    expect(breaker.snapshot().state).toBe('closed');
  });

  it('forgets outcomes older than the window', () => {
    const clock = { now: 0 };
    const breaker = breakerAt(clock);

    for (let i = 0; i < 3; i += 1) {
      breaker.recordFailure();
    }
    clock.now += POLICY.windowMs + 1;
    breaker.recordFailure();

    expect(breaker.snapshot().state).toBe('closed');
  });

  it('moves to half open after the open period and probes once', () => {
    const clock = { now: 0 };
    const breaker = breakerAt(clock);

    for (let i = 0; i < 4; i += 1) {
      breaker.recordFailure();
    }
    expect(breaker.tryAcquire()).toBe(false);

    clock.now += POLICY.openMs;

    expect(breaker.snapshot().state).toBe('half-open');
    expect(breaker.tryAcquire()).toBe(true);
    // a burst of probes would hit the recovering provider with the same load
    // that took it down
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('closes when the probe succeeds', () => {
    const clock = { now: 0 };
    const breaker = breakerAt(clock);

    for (let i = 0; i < 4; i += 1) {
      breaker.recordFailure();
    }
    clock.now += POLICY.openMs;
    breaker.tryAcquire();
    breaker.recordSuccess();

    expect(breaker.snapshot().state).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('reopens when the probe fails, without waiting for volume again', () => {
    const clock = { now: 0 };
    const breaker = breakerAt(clock);

    for (let i = 0; i < 4; i += 1) {
      breaker.recordFailure();
    }
    clock.now += POLICY.openMs;
    breaker.tryAcquire();
    breaker.recordFailure();

    expect(breaker.snapshot().state).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('reports counts for the health check', () => {
    const breaker = breakerAt({ now: 0 });

    breaker.recordSuccess();
    breaker.recordSuccess();
    breaker.recordFailure();

    expect(breaker.snapshot()).toMatchObject({
      provider: 'stub',
      state: 'closed',
      successes: 2,
      failures: 1,
    });
  });
});
