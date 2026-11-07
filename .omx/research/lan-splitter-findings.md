# LAN splitter research — 2026-11-07

## Local sources
- ../piro main has no native LAN implementation. ../piro-lan-pr branch pr/icom-lan-hardware has src/icom-lan/{protocol,stream,session,audio,driver}.js and extensive tests.
- ../piro-lan-pr/docs/icom-lan-sources.md contains official references and provenance. docs/icom-lan-hardware-validation.md records MK2 testing on 2026-11-06; this is recorded evidence, not a new hardware test in this session.
- ../wfweb/src/radio/icomserver.cpp and include/icomserver.h implement downstream Icom sessions, CI-V distribution and audio fanout. dataForServer around1639, receiveAudioData around1722, civReceived around498. Caveats: IP-based stream association, shared codec settings, same controller-address collisions, single streaming-client assumptions. Native server disabled with web active in servermain.cpp around721; --no-web activates path.
- ../wfweb/src/radio/icomudp*.cpp implement upstream radio sessions. packettypes.h describes wire layouts.

## Established technical constraints
Three UDP channels, independent IDs/sequences/pings/retransmission history. Upstream login/token/capability/stream negotiation and downstream independent sessions required. CI-V ACK/NG lack transaction IDs; serialize commands and handle timeout ambiguity. MK2 default address B6. Scope 475 samples in a single LAN division; length requires u16. PiRO currently supports only codec4 mono 48kHz PCM, not arbitrary client codec negotiation. Same receiver state is shared. Preserve GPL/AGPL attribution if code reused.

## Official sources
- https://www.icomjapan.com/support/manual/4459/ Basic pp57–60: LAN AF/12kHz IF, MOD, UDP50001/50002/50003, two credential slots. Two users do not prove two concurrent sessions. Exact MK2 single-session cap remains user-reported.
- https://www.icomjapan.com/support/manual/4487/ Advanced
- https://www.icomjapan.com/support/manual/4486/ CI-V pp9,24: LAN routing and scope layout.
- https://www.icomeurope.com/wp-content/uploads/2022/12/RS-BA1_Ver2_ENG_IM_4.pdf pp5-11,7-2: busy/exclusive radio operation; predates MK2.
- https://wfview.org/wfview-user-manual/faq/ says native LAN wire protocol is undocumented; inner CI-V documentation is separate.

## Online project discovery (not exhaustive)
- https://github.com/wf-group/wfview — mature client/server protocol reference; official development also on GitLab.
- https://github.com/aethersdr/AetherSDR — native MK2 backend, protocol/session/audio/scheduler evidence; TX continuity issue6169 merits investigation.
- https://github.com/rigplane/rigplane-core — redirected from morozsm/icom-lan; README explicitly lists MK2 LAN and USB.
- https://github.com/Dreikor17/radio-webop — README ships MK2 and native RS-BA1 LAN backend.
- https://github.com/dividebysandwich/sdroxide — README explicitly lists MK2 native LAN.
- https://github.com/nonoo/kappanhang — foundational Icom UDP reverse engineering, not independently established MK2 validation.
- https://github.com/microenh/NetworkIcom — IC7610 protocol analysis, not MK2 validation.
- https://github.com/prstoetzer/CardSat/blob/main/docs/interfaces/ICOM_LAN_PROTOCOL.md — IC9700 implementation spec, related protocol reference.
- https://github.com/ok1hra/wifilt/blob/main/SOFTWARE.md — says MK2 expected, not verified.
- https://github.com/cheenle/mrrc_ft710 — related mrrc_modern MK2 support discovery, needs transport verification.
- https://github.com/Hamlib/Hamlib/issues/1975 — MK2 via RS-BA1 virtual COM, not proof of direct LAN transport.
- https://patrick.lidstone.net/wiki/rsba1-protocol/ — Rafe protocol/server-emulation research discovered; pending reading.

No new radio access, tests, implementation, commits, or push performed during interview.
