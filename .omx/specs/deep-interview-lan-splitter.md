# IC-7300MK2 LAN splitter requirements

Status: Implemented and verified with synthetic/native-client tests and three-OS CI.
Physical-radio receive/control, token renewal and brief PTT handover checks passed
on 2026-11-08. RF quality and long-soak behavior remain unmeasured.
See ../../docs/validation.md for current evidence and limits.
Profile: standard, 12 recorded rounds including credential follow-up. Estimated residual ambiguity 15%; target <=20%. This is a judgment estimate, not measured protocol coverage.
Context: greenfield. See ../research/lan-splitter-findings.md and context snapshot under ../context/.

## Intent and outcome
Allow multiple existing native Icom LAN clients to share one IC-7300MK2 without modifying the clients. Exactly one upstream logical radio session, containing the native control, CI-V and audio UDP channels. Multiple independent downstream Icom sessions emulate the radio. No fixed product-level client-count cap; actual capacity remains bounded by CPU, bandwidth and protocol resources.

## Confirmed scope
- Linux, macOS and Windows service.
- Local-network use; clients connect to splitter host using native Icom LAN protocol.
- Clients use the same username/password as configured on the radio. Credentials supplied privately in conversation; do not persist the password in research, source, tests, commits or logs. Runtime credential storage mechanism is an implementation decision and must keep secrets out of version control.
- Every connected client receives RX audio and spectrum/waterfall data, including multiple clients on one host. Share actual radio state; no independent receiver tuning.
- Shared control: tuning and other commands execute in arrival order while receiving. Serialize transactions as needed for unambiguous CI-V ACK attribution.
- Exactly one transmitting client at a time. During its TX, reject/discard other clients' setting changes; never replay them after TX. Other clients retain read/receive access where radio permits.
- On TX-owner disconnect or heartbeat timeout, release PTT/CW, discard pending owner TX data and permit a new TX owner only after release is established. Detecting a dead client takes a timeout; do not claim instant network-loss detection.
- General native-client compatibility is the goal; establish an explicit tested interoperability matrix rather than claim every unknown application is verified.

## Non-goals
No initial rigctld, TCI, WebSocket API, virtual COM/audio-device interfaces, public Internet hosting, web radio UI, independent virtual receivers, or mixed simultaneous transmit audio.

## Decision boundaries
Agent may choose language, architecture, necessary dependencies, packaging approach and reversible defaults. User explicitly authorized necessary dependencies. Preserve source-license obligations if adapting existing implementations. Authentication/session details, codec negotiation, timeout values, local physical-radio controls and disconnect semantics need architecture review; document assumptions rather than silently invent user requirements.

## Hardware testing
User authorized receive/control testing and brief TX tests into a dummy load. Radio address: 10.0.1.25 (user supplied). Reachability, firmware and dummy-load readiness must be established before applicable tests. Do not infer a radio address from the credentials or probe/transmit merely because credentials are available. These are test prerequisites, not requirements to re-ask broad implementation approval. Use a simulator for deterministic failure and multi-client tests first.

## Acceptance criteria
1. Multiple unmodified native LAN clients connect concurrently using the splitter host, including two sharing the same source IP; radio sees one upstream logical session.
2. All clients receive applicable radio state, audio and 475-point MK2 scope data with independent session IDs, sequences, keepalives and retransmission state.
3. Concurrent CI-V commands do not misattribute ACK/NG or replay timed-out writes; shared controller addresses are tested.
4. Control follows arrival order during RX. First accepted TX request acquires exclusive TX ownership. A competing request cannot inject audio/keying or alter settings during TX; discarded changes do not run later.
5. Simulated disconnect/heartbeat expiry releases owner TX and discards its pending media/commands. Upstream-loss behavior is tested and its physical limits documented; if radio unreachable, software cannot guarantee immediate physical unkeying.
6. Per-client disconnect does not terminate other sessions or upstream communication. Upstream reconnect creates fresh session state and does not replay stale TX commands.
7. Slow clients, packet loss/reorder, duplicate packets, sequence wrap and invalid authentication do not corrupt other sessions. Resource handling stays bounded without an arbitrary client-license cap.
8. Explicitly support or reject advertised codec/rate combinations; never silently interpret mismatched audio formats. Determine matrix during architecture/protocol review.
9. Automated checks and install/start/stop validation on Linux, macOS and Windows. Report actual OS coverage honestly when runners unavailable.
10. Hardware receive/control and dummy-load TX checks follow simulator validation and require established hardware prerequisites. Compatibility evidence distinguishes real hardware from synthetic tests.

## Research grounding
See ../research/lan-splitter-findings.md. Strong local starting points: wfweb upstream Icom UDP implementation and downstream icomserver.cpp; piro-lan-pr protocol/session/audio implementation and recorded MK2 hardware tests. Existing server code has shared configuration and source-IP association caveats and is not proven as an unrestricted splitter. Icom manuals document UDP settings and inner CI-V, not full native LAN transport. Two user slots are not proof of concurrent operating sessions. Single upstream session is a binding requirement based on user observation.

## Pressure pass
Initial 'any client, many connections' was tested against conflicting tune/TX actions. User chose shared ordered control, exclusive TX, discard non-owner mutations during TX, and release on client loss. These choices rule out blind datagram forwarding and unrestricted audio mixing.

## Remaining design work
Protocol/session virtualization, transaction scheduler, multi-client same-address routing, codec adaptation, capability advertisements, stream subscriptions, reconnect ownership recovery, bounded resource management and cross-platform distribution need an implementation plan and test specification before coding.
