export interface AdmissionDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface AdmissionController {
  tryAcquire(): AdmissionDecision;
}

export class TokenBucketAdmissionController implements AdmissionController {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly nowMs: () => number = () => performance.now(),
  ) {
    if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
      throw new Error("ratePerSecond must be greater than zero");
    }
    if (!Number.isInteger(burst) || burst <= 0) {
      throw new Error("burst must be a positive integer");
    }

    this.tokens = burst;
    this.lastRefillMs = nowMs();
  }

  tryAcquire(): AdmissionDecision {
    const now = this.nowMs();
    const elapsedMs = Math.max(0, now - this.lastRefillMs);
    this.lastRefillMs = now;

    this.tokens = Math.min(
      this.burst,
      this.tokens + (elapsedMs / 1_000) * this.ratePerSecond,
    );

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const missing = 1 - this.tokens;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(missing / this.ratePerSecond)),
    };
  }
}
