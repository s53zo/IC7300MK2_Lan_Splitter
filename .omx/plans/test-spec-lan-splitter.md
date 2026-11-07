# Test specification

- Protocol: literal packet vectors, lengths/endian layout, malformed input, credential obfuscation, supported codec negotiation and explicit rejection.
- Sessions: independent auth/token/IDs, same-IP requested-port association, separate retransmit state, duplicate handshake/grant handling, token expiry and unknown-client rejection.
- Transport: loss, reorder, duplicates, retransmit, sequence wrap, per-peer timeout, replay invalidation and bounded buffers/backpressure.
- Broker: simultaneous shared-address clients, per-request ACK/NG and reads, notifications/scope fanout, arrival order, late ACK/reset, no queued commands after disconnect/reconnect.
- TX: one owner, reject competing keying/audio and setting changes at arrival and execution; PTT off and CW stop, confirmed RX before new owner, release on explicit exit and heartbeat timeout, upstream outage recovery, no retransmission of old owner media.
- Integration: independent synthetic radio and clients over real UDP sockets, unmodified PiRO session clients, mixed formats where supported, disconnect one without affecting others, 475-point scope/audio identity and fanout capacity measurement.
- Operations: bad config/redacted diagnostics, CLI help/start/stop, clean process/timer/socket shutdown, npm package manifest, syntax/lint/static checks and Node multi-OS CI.
- Hardware: verify idle availability before opening one connection; RX/control and optionally dummy-load TX only after readiness. Clearly distinguish captured evidence, synthetic results, prior sibling hardware records and new hardware tests.
