/**
 * SWIM-style indirect probing (Das, Gupta, Motivala 2002).
 *
 * A high φ (phi-accrual.ts) means "I haven't heard from this peer" — but a single
 * silent link is a single point of false-positive: the peer may be alive and
 * merely unreachable from ME. SWIM's fix: before declaring it dead, ask *k* other
 * peers (relays) to probe it on my behalf. If ANY relay gets an ack, the peer is
 * alive and the suspicion is cleared; only when no relay can reach it either is it
 * confirmed dead. This collapses single-link false positives — the expensive
 * mistake, since evicting a live agent aborts real work.
 *
 * GENERIC over the peer type `P`: a peer is opaque here. The caller injects the
 * relay-probe transport (`RelayProbe<P>`) — the only host coupling — and, for
 * object-shaped peers, a `label(peer)` extractor so the result reads in the
 * host's own identifiers (the default is `String(peer)`, right for string peers).
 * This module is PURE orchestration over the injected probe; it lights up when a
 * real transport lands, with no change here.
 */

import { PHI_REVOKE_THRESHOLD } from './phi-accrual';

/**
 * Probe `target` via `relay`. Resolves true if the relay got an ack from the
 * target (alive), false if the relay actively reports the target dead, and
 * REJECTS if the relay itself is unreachable. A transport that rejects every call
 * (e.g. no P2P RPC yet) means no relay can confirm alive → fail-open eviction
 * stays governed by the caller's policy.
 */
export type RelayProbe<P> = (relay: P, target: P) => Promise<boolean>;

export interface IndirectProbeResult {
  /** True if ANY relay confirmed the target alive (SWIM: one ack clears suspicion). */
  alive: boolean;
  /** Relay labels that got an ack (target alive via them). */
  confirmedBy: string[];
  /** Relay labels that reported the target dead. */
  deadBy: string[];
  /** Relay labels that were themselves unreachable (no signal). */
  unreachable: string[];
}

export interface IndirectProbeOptions<P> {
  /** Probe only the first `k` relays. Default: all of them. */
  k?: number;
  /**
   * How to render a peer in the result's label lists. Default `String(peer)` —
   * correct for string peers; object-shaped peers should pass an extractor
   * (e.g. `p => p.machineLabel || p.devicePubkey.slice(0, 8)`).
   */
  label?: (peer: P) => string;
}

/**
 * Ask up to `k` relays to probe `target`. Returns alive iff at least one relay
 * got an ack. Relays are probed concurrently; an unreachable relay contributes no
 * signal (neither alive nor dead).
 */
export async function indirectProbe<P>(
  target: P,
  relays: P[],
  probe: RelayProbe<P>,
  opts: IndirectProbeOptions<P> = {},
): Promise<IndirectProbeResult> {
  const k = Math.max(0, Math.min(opts.k ?? relays.length, relays.length));
  const label = opts.label ?? ((p: P) => String(p));
  const chosen = relays.slice(0, k);
  const settled = await Promise.allSettled(chosen.map((r) => probe(r, target)));

  const confirmedBy: string[] = [];
  const deadBy: string[] = [];
  const unreachable: string[] = [];
  settled.forEach((res, i) => {
    const lbl = label(chosen[i]!); // settled is chosen.map(...) — same length, [i] always present (noUncheckedIndexedAccess-safe)
    if (res.status === 'fulfilled') {
      (res.value ? confirmedBy : deadBy).push(lbl);
    } else {
      unreachable.push(lbl);
    }
  });

  return { alive: confirmedBy.length > 0, confirmedBy, deadBy, unreachable };
}

export interface EvictionDecision {
  evict: boolean;
  reason: 'alive-direct' | 'alive-indirect' | 'confirmed-dead' | 'no-relays-high-phi';
}

/**
 * Combine φ-accrual with SWIM: a peer is only evicted when BOTH the direct signal
 * is highly suspicious (φ ≥ threshold) AND the indirect probe fails to find it
 * alive. A low φ keeps it; a relay ack keeps it; only an across-the-board silence
 * evicts. When no relay reached a verdict, a high φ alone decides (degrades to the
 * bare detector) — flagged via the `no-relays-high-phi` reason.
 *
 * "No relay reached a verdict" means: a literal `null` indirect (the caller never
 * probed), OR a result where nobody confirmed alive AND nobody reported dead —
 * i.e. an empty relay set, `k ≤ 0`, or every relay itself unreachable. All of
 * these are observationally "we asked no one / got no signal", so they share the
 * `no-relays-high-phi` reason. `confirmed-dead` is reserved for the case a
 * REACHABLE relay actually reported the target dead — without this, an empty /
 * all-unreachable result was mis-attributed as `confirmed-dead`, falsely claiming
 * a witness agreed (the composition the two pure fns are meant to support).
 */
export function decideEviction(
  phi: number,
  indirect: IndirectProbeResult | null,
  threshold: number = PHI_REVOKE_THRESHOLD,
): EvictionDecision {
  if (phi < threshold) return { evict: false, reason: 'alive-direct' };
  if (indirect == null) return { evict: true, reason: 'no-relays-high-phi' };
  if (indirect.alive) return { evict: false, reason: 'alive-indirect' };
  // No relay reached a verdict (empty / k≤0 / all unreachable) → no witness, same
  // as having no relays at all. Don't claim a relay confirmed it dead.
  if (indirect.confirmedBy.length === 0 && indirect.deadBy.length === 0) {
    return { evict: true, reason: 'no-relays-high-phi' };
  }
  return { evict: true, reason: 'confirmed-dead' };
}
