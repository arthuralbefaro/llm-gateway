import { ProviderError } from '../providers/provider.types';

export type BreakerState = 'closed' | 'open' | 'half-open';

/**
 * Raised instead of calling a provider whose circuit is open.
 *
 * It is a ProviderError so the gateway maps it to a status rather than a 500,
 * and not retryable because the whole point is to stop calling. It carries 503
 * rather than 502: nothing upstream answered badly, we declined to ask.
 */
export class CircuitOpenError extends ProviderError {
  constructor(provider: string) {
    super(`circuit open for ${provider}`, provider, 503, false);
    this.name = 'CircuitOpenError';
  }
}

export interface BreakerPolicy {
  failureRatio: number;
  minimumVolume: number;
  windowMs: number;
  openMs: number;
}

export interface BreakerSnapshot {
  provider: string;
  state: BreakerState;
  failures: number;
  successes: number;
  openedAt?: number;
}

interface Outcome {
  at: number;
  ok: boolean;
}

/**
 * One breaker per provider.
 *
 * State lives in memory. Sharing it through redis would let instances learn
 * from each other, at the cost of a network round trip on the hot path of every
 * request and a dependency that can fail while deciding whether something else
 * has failed. In memory each instance learns on its own, which costs a few
 * wasted calls per instance after a provider dies, and keeps the decision local
 * and instant. When instance count grows enough for that waste to matter, the
 * shared version becomes worth its cost, and this is the seam to change.
 */
export class CircuitBreaker {
  private outcomes: Outcome[] = [];
  private state: BreakerState = 'closed';
  private openedAt = 0;
  private probeInFlight = false;

  constructor(
    readonly provider: string,
    private readonly policy: BreakerPolicy,
    private readonly now: () => number = Date.now,
    // observation only, it never influences whether a call is admitted
    private readonly onTransition?: (to: BreakerState) => void,
  ) {}

  /**
   * Whether a call may go out, and reserves the single probe when half open.
   */
  tryAcquire(): boolean {
    this.refresh();

    if (this.state === 'closed') {
      return true;
    }
    if (this.state === 'open') {
      return false;
    }
    // half open lets a single probe through, not a burst, otherwise recovery
    // arrives as the same stampede that took the provider down
    if (this.probeInFlight) {
      return false;
    }
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.probeInFlight = false;
    if (this.state === 'half-open') {
      this.close();
      return;
    }
    this.push(true);
  }

  recordFailure(): void {
    this.probeInFlight = false;
    if (this.state === 'half-open') {
      this.open();
      return;
    }
    this.push(false);
    this.evaluate();
  }

  snapshot(): BreakerSnapshot {
    this.refresh();
    const failures = this.outcomes.filter((outcome) => !outcome.ok).length;

    return {
      provider: this.provider,
      state: this.state,
      failures,
      successes: this.outcomes.length - failures,
      openedAt: this.state === 'closed' ? undefined : this.openedAt,
    };
  }

  private refresh(): void {
    this.prune();

    if (
      this.state === 'open' &&
      this.now() - this.openedAt >= this.policy.openMs
    ) {
      this.transition('half-open');
      this.probeInFlight = false;
    }
  }

  // pruning belongs here too, the window must not depend on somebody having
  // called tryAcquire first
  private prune(): void {
    const cutoff = this.now() - this.policy.windowMs;
    this.outcomes = this.outcomes.filter((outcome) => outcome.at > cutoff);
  }

  private push(ok: boolean): void {
    this.prune();
    this.outcomes.push({ at: this.now(), ok });
  }

  private evaluate(): void {
    // a ratio rather than a count, because five failures in five requests and
    // five in five thousand are not the same provider
    if (this.outcomes.length < this.policy.minimumVolume) {
      return;
    }
    const failures = this.outcomes.filter((outcome) => !outcome.ok).length;
    if (failures / this.outcomes.length >= this.policy.failureRatio) {
      this.open();
    }
  }

  private open(): void {
    this.transition('open');
    this.openedAt = this.now();
    this.probeInFlight = false;
  }

  private close(): void {
    this.transition('closed');
    this.outcomes = [];
    this.probeInFlight = false;
  }

  private transition(to: BreakerState): void {
    if (this.state === to) {
      return;
    }
    this.state = to;
    this.onTransition?.(to);
  }
}
