/**
 * failure-detector — φ-accrual + SWIM indirect probing. Pure, deterministic.
 *
 * Algorithm-conformance suite (moved with the lib from operator-core/lib/authority
 * via generalize-libs-to-generic-2026-06-05, row #2). The SWIM peers here are a
 * plain `{ id }` shape with an injected `label` — the lib is generic over the peer
 * type; the host (operator) binds its own peer ref + label when it wires eviction.
 */

import { describe, it, expect } from 'vitest';
import { PhiAccrualDetector, PHI_REVOKE_THRESHOLD } from './phi-accrual';
import { indirectProbe, decideEviction } from './swim-probe';

function feedSteady(d: PhiAccrualDetector, intervalMs: number, count: number, startMs = 0): number {
  let t = startMs;
  for (let i = 0; i < count; i++) {
    d.heartbeat(t);
    t += intervalMs;
  }
  return t - intervalMs; // last arrival time
}

describe('PhiAccrualDetector', () => {
  it('reports 0 suspicion before any heartbeat is observed', () => {
    const d = new PhiAccrualDetector();
    expect(d.phi(123456)).toBe(0);
    expect(d.isAvailable(123456)).toBe(true);
  });

  it('φ is near 0 just after a beat and rises past the threshold as silence grows', () => {
    const d = new PhiAccrualDetector({ minStdDevMs: 50 });
    const last = feedSteady(d, 1000, 30);
    // Right at the last beat → no suspicion.
    expect(d.phi(last)).toBe(0);
    // ~one expected interval later → still low (< the hint level).
    expect(d.phi(last + 1000)).toBeLessThan(1);
    // Far past the expected interval → astronomically suspicious.
    expect(d.phi(last + 10_000)).toBeGreaterThan(PHI_REVOKE_THRESHOLD);
  });

  it('flips isAvailable from true to false as a peer goes silent', () => {
    const d = new PhiAccrualDetector({ minStdDevMs: 50 });
    const last = feedSteady(d, 1000, 30);
    expect(d.isAvailable(last + 500)).toBe(true);
    expect(d.isAvailable(last + 10_000)).toBe(false);
  });

  it('is MORE tolerant of a peer with jittery (high-variance) heartbeats', () => {
    const steady = new PhiAccrualDetector({ minStdDevMs: 50 });
    const jittery = new PhiAccrualDetector({ minStdDevMs: 50 });
    let ts = 0;
    let tj = 0;
    for (let i = 0; i < 30; i++) {
      steady.heartbeat(ts);
      ts += 1000;
      jittery.heartbeat(tj);
      tj += i % 2 === 0 ? 500 : 1500; // mean ~1000 but high variance
    }
    const lastS = ts - 1000;
    const lastJ = tj - 1500;
    // At the same elapsed past the last beat, the jittery peer is LESS suspected.
    expect(jittery.phi(lastJ + 2000)).toBeLessThan(steady.phi(lastS + 2000));
  });
});

describe('SWIM indirect probing', () => {
  interface TestPeer {
    id: string;
  }
  const peer = (id: string): TestPeer => ({ id });
  const label = (p: TestPeer) => p.id;
  const target = peer('target');
  const relays = [peer('r1'), peer('r2'), peer('r3')];

  it('one relay ack clears the suspicion (alive)', async () => {
    const probe = async (r: TestPeer) => r.id === 'r2'; // only r2 reaches target
    const res = await indirectProbe(target, relays, probe, { label });
    expect(res.alive).toBe(true);
    expect(res.confirmedBy).toEqual(['r2']);
    expect(res.deadBy.sort()).toEqual(['r1', 'r3']);
  });

  it('all relays report dead → not alive', async () => {
    const res = await indirectProbe(target, relays, async () => false, { label });
    expect(res.alive).toBe(false);
    expect(res.deadBy.length).toBe(3);
  });

  it('unreachable relays contribute no signal', async () => {
    const res = await indirectProbe(target, relays, async () => {
      throw new Error('relay unreachable');
    }, { label });
    expect(res.alive).toBe(false);
    expect(res.unreachable.length).toBe(3);
    expect(res.confirmedBy.length).toBe(0);
  });

  it('honors k (probe only the first k relays)', async () => {
    let calls = 0;
    await indirectProbe(target, relays, async () => {
      calls++;
      return false;
    }, { k: 2, label });
    expect(calls).toBe(2);
  });

  it('defaults the peer label to String(peer) when no extractor is given', async () => {
    const res = await indirectProbe('target', ['r1', 'r2'], async (r) => r === 'r1');
    expect(res.confirmedBy).toEqual(['r1']);
    expect(res.deadBy).toEqual(['r2']);
  });
});

describe('decideEviction (φ-accrual + SWIM combined)', () => {
  const aliveResult = { alive: true, confirmedBy: ['r1'], deadBy: [], unreachable: [] };
  const deadResult = { alive: false, confirmedBy: [], deadBy: ['r1', 'r2'], unreachable: [] };

  it('keeps a peer whose φ is below the threshold (no probe needed)', () => {
    expect(decideEviction(2, null)).toEqual({ evict: false, reason: 'alive-direct' });
  });

  it('keeps a high-φ peer that a relay confirmed alive (false positive avoided)', () => {
    expect(decideEviction(12, aliveResult)).toEqual({ evict: false, reason: 'alive-indirect' });
  });

  it('evicts only when φ is high AND no relay finds it alive', () => {
    expect(decideEviction(12, deadResult)).toEqual({ evict: true, reason: 'confirmed-dead' });
  });

  it('with no relays, a high φ alone evicts (degrades to the bare detector)', () => {
    expect(decideEviction(12, null)).toEqual({ evict: true, reason: 'no-relays-high-phi' });
  });

  // ── F1: empty / no-signal indirect result must NOT be mis-attributed as
  // `confirmed-dead` — no relay reached a verdict, so it is the no-relays case. ──
  it('an EMPTY-relay probe result is no-relays-high-phi, not confirmed-dead (F1)', async () => {
    // The two pure fns are meant to compose: probe over [] then decide.
    const empty = await indirectProbe('t', [], async () => false);
    expect(empty).toEqual({ alive: false, confirmedBy: [], deadBy: [], unreachable: [] });
    // High φ + an empty result = "we asked no one", same as `null`. Must NOT
    // falsely claim a witness confirmed it dead.
    expect(decideEviction(12, empty)).toEqual({ evict: true, reason: 'no-relays-high-phi' });
    // The boolean verdict is unchanged from the bare-φ path — only the reason is
    // corrected from the (false) `confirmed-dead`.
    expect(decideEviction(12, empty).evict).toBe(decideEviction(12, null).evict);
  });

  it('a k=0 probe result is no-relays-high-phi, not confirmed-dead (F1/F4)', async () => {
    const k0 = await indirectProbe('t', ['r1', 'r2'], async () => false, { k: 0 });
    expect(k0).toEqual({ alive: false, confirmedBy: [], deadBy: [], unreachable: [] });
    expect(decideEviction(12, k0)).toEqual({ evict: true, reason: 'no-relays-high-phi' });
  });

  it('an ALL-UNREACHABLE probe result is no-relays-high-phi (no witness reached a verdict) (F1)', async () => {
    const allUnreach = await indirectProbe('t', ['r1', 'r2'], async () => {
      throw new Error('relay unreachable');
    });
    expect(allUnreach.confirmedBy).toEqual([]);
    expect(allUnreach.deadBy).toEqual([]);
    expect(allUnreach.unreachable.length).toBe(2);
    // Every relay was itself unreachable → no signal → we are blind, not the
    // target confirmed dead. Still evicts on bare φ, but truthfully labeled.
    expect(decideEviction(12, allUnreach)).toEqual({ evict: true, reason: 'no-relays-high-phi' });
  });

  it('a genuine relay "dead" report (≥1 reachable witness) IS confirmed-dead (F1 negative)', () => {
    // The discriminator: a non-empty deadBy means a reachable relay actually
    // reported the target dead — THAT is confirmed-dead, and must stay so.
    const witnessedDead = { alive: false, confirmedBy: [], deadBy: ['r1'], unreachable: ['r2'] };
    expect(decideEviction(12, witnessedDead)).toEqual({ evict: true, reason: 'confirmed-dead' });
  });

  // ── F2: φ boundary is EXCLUSIVE (`phi < threshold`) — φ === threshold is NOT
  // below, so it falls through to the eviction path. ──
  it('φ exactly === threshold is on the eviction side (exclusive < boundary) (F2)', () => {
    // default threshold = PHI_REVOKE_THRESHOLD = 8.
    expect(PHI_REVOKE_THRESHOLD).toBe(8);
    expect(decideEviction(8, null)).toEqual({ evict: true, reason: 'no-relays-high-phi' });
    // Just below the boundary stays alive-direct.
    expect(decideEviction(7.999999, null)).toEqual({ evict: false, reason: 'alive-direct' });
    // A relay ack at the boundary still rescues it.
    const aliveRes = { alive: true, confirmedBy: ['r1'], deadBy: [], unreachable: [] };
    expect(decideEviction(8, aliveRes)).toEqual({ evict: false, reason: 'alive-indirect' });
  });

  it('respects a custom threshold at its exact boundary (F2)', () => {
    expect(decideEviction(5, null, 5)).toEqual({ evict: true, reason: 'no-relays-high-phi' });
    expect(decideEviction(4.999, null, 5)).toEqual({ evict: false, reason: 'alive-direct' });
  });
});

describe('PhiAccrualDetector boundary + edge cases (F2/F3/F4)', () => {
  // ── F2: isAvailable uses `phi(now) < threshold` — same EXCLUSIVE boundary. ──
  it('isAvailable is false at φ exactly === threshold (exclusive boundary) (F2)', () => {
    // Drive φ to land exactly on a chosen threshold by USING that φ as the
    // threshold: isAvailable(now, φ(now)) is `φ < φ` === false for any finite φ.
    const d = new PhiAccrualDetector({ minStdDevMs: 50 });
    const last = feedSteady(d, 1000, 30);
    const now = last + 5000;
    const phiNow = d.phi(now);
    expect(phiNow).toBeGreaterThan(0);
    // threshold === current φ → not below → unavailable (exclusive).
    expect(d.isAvailable(now, phiNow)).toBe(false);
    // threshold a hair above current φ → below → available.
    expect(d.isAvailable(now, phiNow + 1e-9)).toBe(true);
  });

  // ── F4: cold-start / low-sample φ must be FINITE (no NaN / Infinity). ──
  it('φ with a SINGLE sample is finite (stdDev floors via mean*0.5) (F4)', () => {
    const d = new PhiAccrualDetector({ minStdDevMs: 50 });
    d.heartbeat(0);
    d.heartbeat(1000); // exactly one interval sample
    expect(d.stats().samples).toBe(1);
    const phi = d.phi(1000 + 5000);
    expect(Number.isFinite(phi)).toBe(true);
    expect(phi).toBeGreaterThan(0);
  });

  it('φ with ZERO samples (one beat seen) is finite, using the cold-start mean (F4)', () => {
    const d = new PhiAccrualDetector({ initialMeanMs: 30_000, minStdDevMs: 50 });
    d.heartbeat(0); // a single beat → lastArrivalMs set, but no interval sample yet
    expect(d.stats().samples).toBe(0);
    expect(d.stats().meanMs).toBe(30_000); // falls back to initialMean
    const phi = d.phi(60_000); // 2× the assumed mean of silence
    expect(Number.isFinite(phi)).toBe(true);
    expect(phi).toBeGreaterThan(0);
    // stdDev with <2 samples = max(minStdDev, mean*0.5) = max(50, 15000) = 15000.
    expect(d.stats().stdDevMs).toBe(15_000);
  });

  it('φ stays finite even at an astronomically long silence (clamped, not Infinity) (F4)', () => {
    const d = new PhiAccrualDetector({ minStdDevMs: 50 });
    feedSteady(d, 1000, 30);
    const phi = d.phi(1_000_000_000); // ~ effectively "forever" past the last beat
    expect(Number.isFinite(phi)).toBe(true);
    // pLater clamped to 1e-12 → φ clamped to -log10(1e-12) = 12.
    expect(phi).toBeCloseTo(12, 6);
  });

  // ── F4: k clamp on indirectProbe — k≤0 → 0 probe calls. ──
  it('indirectProbe clamps k=0 to zero probe calls (F4)', async () => {
    let calls = 0;
    const res = await indirectProbe('t', ['r1', 'r2', 'r3'], async () => { calls++; return false; }, { k: 0 });
    expect(calls).toBe(0);
    expect(res).toEqual({ alive: false, confirmedBy: [], deadBy: [], unreachable: [] });
  });

  it('indirectProbe clamps a NEGATIVE k to zero probe calls (F4)', async () => {
    let calls = 0;
    const res = await indirectProbe('t', ['r1', 'r2'], async () => { calls++; return true; }, { k: -1 });
    expect(calls).toBe(0);
    expect(res.alive).toBe(false);
  });

  it('indirectProbe clamps k ABOVE the relay count down to the relay count (F4)', async () => {
    let calls = 0;
    await indirectProbe('t', ['r1', 'r2'], async () => { calls++; return false; }, { k: 99 });
    expect(calls).toBe(2);
  });

  // ── F3: backwards / duplicate heartbeat — PIN the current behavior. ──
  it('a duplicate heartbeat (same timestamp) records NO new interval (F3)', () => {
    const d = new PhiAccrualDetector();
    d.heartbeat(1000);
    d.heartbeat(1000); // interval === 0, not > 0 → not pushed
    expect(d.stats().samples).toBe(0);
    expect(d.stats().lastArrivalMs).toBe(1000);
  });

  it('a BACKWARDS heartbeat records no interval but DOES rewind the arrival anchor (F3, pinned)', () => {
    // PINNED current behavior: heartbeat() always sets lastArrivalMs=now, even for
    // a backwards beat (phi-accrual.ts:78). The negative interval is dropped (not
    // > 0), so no bad sample enters the window — but the anchor moves back, so a
    // subsequent phi() is measured from the EARLIER time. This is the documented
    // F3 behavior; not force-fixed (see report).
    const d = new PhiAccrualDetector();
    d.heartbeat(0);
    d.heartbeat(1000); // one good sample
    expect(d.stats().samples).toBe(1);
    d.heartbeat(500); // backwards beat: 500 - 1000 = -500, dropped; anchor → 500
    expect(d.stats().samples).toBe(1); // no new (bad) sample entered the window
    expect(d.stats().lastArrivalMs).toBe(500); // anchor rewound to the backwards beat
    // φ is now measured from 500, so at t=1000 only 500ms have "elapsed".
    const phi = d.phi(1000);
    expect(Number.isFinite(phi)).toBe(true);
    expect(phi).toBeGreaterThanOrEqual(0);
  });

  it('a forward beat AFTER a backwards rewind measures the interval from the rewound anchor (F3, pinned)', () => {
    const d = new PhiAccrualDetector();
    d.heartbeat(0);
    d.heartbeat(1000);
    d.heartbeat(500); // rewind anchor to 500
    d.heartbeat(2000); // interval = 2000 - 500 = 1500 (measured off the rewound anchor)
    expect(d.stats().samples).toBe(2);
    expect(d.stats().lastArrivalMs).toBe(2000);
  });
});
