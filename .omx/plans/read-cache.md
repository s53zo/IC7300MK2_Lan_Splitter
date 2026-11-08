# Ordered client read cache

User approved implementation 2026-11-08. Client meter, ADC overflow, RX/TX and tuner reads: 100 ms. Slower public operator settings: 250 ms. Frequency/mode/VFO: 50 ms. Combine identical queued/in-flight reads without crossing mutation barriers. Internal polling, release, mode checks and TX safety always perform a new radio transaction.

## Implementation
- Pure explicit MK2 query allowlist with exact request and successful-reply shapes. No writes, ACK/NG, waveform, unknown or blanket network/menu queries. Classify allowlisted scope reads correctly.
- Keep each logical request in the existing bounded FIFO. Look up cache only at dispatch; reads never leapfrog a queued write. A reply can satisfy already-queued identical reads (coalescing) or later reads within TTL.
- Mutation admission advances a cache epoch and clears entries. Dispatch/outcome also clear entries. A pre-barrier reply cannot populate the new epoch. Reconnect/loss and unsolicited state notifications invalidate; scope samples do not. TX transition/release invalidates. Client generations and permissions checked for every hit.
- Cache only validated successful data, rebuild client destination, do not broadcast cached values as new state or use cached values for broker safety decisions.
- Stable fresh internal polls may prime the client display cache but never use it; startup/release checks neither consume nor prime it.
- Bounded entries, monotonic expiry, per-key hit/miss/coalesced metrics, configurable TTLs/off switch, redacted operator status via SIGUSR2.

## Verification
Deterministic fake-clock regression coverage for TTL boundaries, mixed clients/controllers, queued write barriers, late pre-write replies, rejected writes, notifications, reconnect, disconnect/regrant, malformed replies and internal bypass. Real UDP synthetic integration for one physical query serving multiple clients. Run full suite/lint/syntax/package and six-platform CI. Stage versioned release on .82, retain previous release for rollback, activate once, verify readiness/client traffic and cache counters. No RF tests or audio-path changes in this task.
