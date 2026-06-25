/**
 * φ-accrual failure detector (Hayashibara et al. 2004; Cassandra/Akka).
 *
 * A fixed heartbeat timeout ("dead if no beat for 90s") forces a binary,
 * one-size choice: tight enough to evict a genuinely-dead peer quickly = too
 * tight under jitter, so it false-positives and EVICTS LIVE AGENTS — expensive,
 * because killing a session aborts real work. φ-accrual replaces the binary
 * timeout with a CONTINUOUS suspicion level φ derived from the observed
 * distribution of heartbeat inter-arrivals:
 *
 *   φ(t) = -log10( P_later(t) )
 *
 * where P_later(t) is the probability that the NEXT heartbeat arrives later than
 * the time already elapsed since the last one, under a normal model fitted to
 * the recent inter-arrival samples. φ rises smoothly as a peer goes quiet and
 * — crucially — rises SLOWER for a peer whose heartbeats are naturally jittery
 * (high variance), so a bursty-but-alive peer isn't wrongly evicted.
 *
 * Different actions pick different thresholds off the SAME signal: a
 * lease-revocation (expensive to get wrong) demands a HIGH φ (≈8, "astronomically
 * unlikely to be alive"); a UI "looks idle" hint uses a LOW φ (≈1).
 *
 * PURE module (no I/O, no timers) — the caller feeds it `heartbeat(now)` on each
 * observed beat and reads `phi(now)` / `isAvailable(now, threshold)` whenever it
 * needs the current suspicion. Deterministic + unit-testable.
 */

/** Standard normal CDF via the Abramowitz-Stegun 7.1.26 erf approximation. */
function normalCdf(x: number, mean: number, stddev: number): number {
  const z = (x - mean) / (stddev * Math.SQRT2);
  // erf(z)
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

export interface PhiAccrualOptions {
  /** Sliding window size of inter-arrival samples. Default 100. */
  windowSize?: number;
  /** Minimum stddev (ms) — floors over-confidence when samples are near-identical. Default 50. */
  minStdDevMs?: number;
  /** Assumed mean inter-arrival (ms) before any sample is seen (cold start). Default 30000. */
  initialMeanMs?: number;
}

/** A reasonable φ threshold for an EXPENSIVE action (lease revocation / eviction). */
export const PHI_REVOKE_THRESHOLD = 8;
/** A low φ threshold for a cheap hint (UI "looks idle"). */
export const PHI_HINT_THRESHOLD = 1;

export class PhiAccrualDetector {
  private readonly windowSize: number;
  private readonly minStdDev: number;
  private readonly initialMean: number;
  private intervals: number[] = [];
  private lastArrivalMs: number | null = null;

  constructor(opts: PhiAccrualOptions = {}) {
    this.windowSize = opts.windowSize ?? 100;
    this.minStdDev = opts.minStdDevMs ?? 50;
    this.initialMean = opts.initialMeanMs ?? 30_000;
  }

  /** Record an observed heartbeat at `nowMs`. */
  heartbeat(nowMs: number): void {
    if (this.lastArrivalMs != null) {
      const interval = nowMs - this.lastArrivalMs;
      if (interval > 0) {
        this.intervals.push(interval);
        if (this.intervals.length > this.windowSize) this.intervals.shift();
      }
    }
    this.lastArrivalMs = nowMs;
  }

  private mean(): number {
    if (this.intervals.length === 0) return this.initialMean;
    return this.intervals.reduce((a, b) => a + b, 0) / this.intervals.length;
  }

  private stdDev(mean: number): number {
    if (this.intervals.length < 2) return Math.max(this.minStdDev, mean * 0.5);
    const variance =
      this.intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / this.intervals.length;
    return Math.max(this.minStdDev, Math.sqrt(variance));
  }

  /**
   * The current suspicion level. 0 right after a beat; rises without bound as the
   * silence grows past the expected inter-arrival. ∞-safe: clamped to a large
   * finite value. Returns 0 before the first heartbeat is seen.
   */
  phi(nowMs: number): number {
    if (this.lastArrivalMs == null) return 0;
    const elapsed = nowMs - this.lastArrivalMs;
    if (elapsed <= 0) return 0;
    const mean = this.mean();
    const stddev = this.stdDev(mean);
    // P_later(elapsed) = P(X > elapsed) = 1 - CDF(elapsed).
    const pLater = 1 - normalCdf(elapsed, mean, stddev);
    const clamped = Math.max(pLater, 1e-12); // avoid -log10(0) = Infinity
    return -Math.log10(clamped);
  }

  /** True while the peer's suspicion is below `threshold` (i.e. still trusted alive). */
  isAvailable(nowMs: number, threshold = PHI_REVOKE_THRESHOLD): boolean {
    return this.phi(nowMs) < threshold;
  }

  /** Diagnostics: current sample count + fitted mean/stddev. */
  stats(): { samples: number; meanMs: number; stdDevMs: number; lastArrivalMs: number | null } {
    const mean = this.mean();
    return { samples: this.intervals.length, meanMs: mean, stdDevMs: this.stdDev(mean), lastArrivalMs: this.lastArrivalMs };
  }
}
