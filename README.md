# @papercusp/failure-detector

A generic, **pure** failure detector — two textbook distributed-systems algorithms
over an injected transport, plus a combined eviction policy. Zero I/O, zero timers,
zero domain coupling.

## Why

A fixed heartbeat timeout ("dead if no beat for 90s") is a binary, one-size choice:
tight enough to evict a genuinely-dead peer quickly is too tight under jitter, so it
false-positives and evicts **live** peers — expensive when killing a session aborts
real work. This lib replaces that with a continuous suspicion signal and a relayed
second opinion before eviction.

## What's in it

| Export | What |
|---|---|
| `PhiAccrualDetector` | φ-accrual (Hayashibara 2004). A continuous suspicion level `φ(t) = -log₁₀(P_later(t))` fitted to the observed heartbeat inter-arrival distribution. Rises smoothly as a peer goes quiet, and **slower** for a naturally-jittery peer. Feed `heartbeat(now)`; read `phi(now)` / `isAvailable(now, threshold)`. |
| `indirectProbe` | SWIM indirect probing (Das 2002). Before declaring a peer dead, ask *k* relays to probe it; one ack clears the suspicion. Generic over the peer type — you inject the `RelayProbe` transport. |
| `decideEviction` | Combine the two: evict only when φ is high **and** no relay finds the peer alive. |
| `PHI_REVOKE_THRESHOLD` / `PHI_HINT_THRESHOLD` | Sensible φ thresholds — high (≈8) for an expensive action (eviction), low (≈1) for a cheap hint (UI "looks idle"). |

## The seam — inject the transport (and a peer label)

The lib names no peer type and holds no transport. The **only** host coupling is the
relay-probe function; object-shaped peers also pass a `label` extractor so results
read in the host's own identifiers:

```ts
import { indirectProbe, decideEviction, PhiAccrualDetector } from '@papercusp/failure-detector';

// Per peer: a detector fed by your heartbeat stream.
const detector = new PhiAccrualDetector();
onHeartbeat((peer, now) => detectorFor(peer).heartbeat(now));

// When φ is high, get a second opinion from k relays over YOUR transport.
const result = await indirectProbe(target, relays, myRelayProbe, {
  k: 3,
  label: (p) => p.machineLabel || p.devicePubkey.slice(0, 8), // host's peer id
});

const { evict } = decideEviction(detector.phi(now), result);
```

`RelayProbe` resolves `true` when a relay acked the target (alive), `false` when it
reports the target dead, and **rejects** when the relay itself is unreachable (no
signal). A transport that rejects every call (e.g. no P2P RPC yet) means no relay can
confirm alive — eviction then degrades to the bare φ signal, governed by the caller.

## Tests

```bash
npm test   # vitest run — algorithm-conformance suite (deterministic, no I/O)
```
