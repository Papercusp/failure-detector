/**
 * @papercusp/failure-detector — a generic, pure failure detector.
 *
 * Two textbook distributed-systems algorithms over an injected transport, plus a
 * combined eviction policy:
 *
 * - {@link PhiAccrualDetector} — φ-accrual (Hayashibara 2004): a continuous
 *   suspicion level φ from observed heartbeat inter-arrivals, instead of a binary
 *   timeout. Feed it `heartbeat(now)`; read `phi(now)` / `isAvailable(now, φ)`.
 * - {@link indirectProbe} — SWIM (Das 2002): ask k relays to probe a target
 *   before declaring it dead. Generic over the peer type; the caller injects the
 *   {@link RelayProbe} transport (the only host coupling).
 * - {@link decideEviction} — combine the two: evict only when φ is high AND no
 *   relay finds the peer alive.
 *
 * PURE: no I/O, no timers, no domain types. The consumer feeds heartbeats and
 * injects the relay probe; the lib decides suspicion + whether to evict.
 */

export {
  PhiAccrualDetector,
  PHI_REVOKE_THRESHOLD,
  PHI_HINT_THRESHOLD,
  type PhiAccrualOptions,
} from './phi-accrual';

export {
  indirectProbe,
  decideEviction,
  type RelayProbe,
  type IndirectProbeResult,
  type IndirectProbeOptions,
  type EvictionDecision,
} from './swim-probe';
