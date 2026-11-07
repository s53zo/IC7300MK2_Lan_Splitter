# Source attribution

This project is licensed under AGPL-3.0-only; see LICENSE.

The files src/icom-lan/{protocol,stream,session,audio}.js were copied from
Simon S53ZO's PiRO checkout (branch pr/icom-lan-hardware) on 2026-11-07.
PiRO is AGPL-3.0-only. Original project: https://github.com/StevPem/piro;
LAN fork: https://github.com/s53zo/piro. Credit to PiRO contributors. The packet primitives in protocol.js are adapted from
AetherSDR contributors' GPL-3.0 IcomProtocol implementation, cross-checked
against wfview. Their GPL-3.0 license is included in third_party/icom-lan.
Original file notices remain intact. Tests will also credit imported fixtures.

Protocol lineage: AetherSDR https://github.com/aethersdr/AetherSDR,
wfview https://github.com/wf-group/wfview and https://gitlab.com/eliggett/wfview,
nonoo/kappanhang https://github.com/nonoo/kappanhang.
See docs/research.md for pinned revisions, source provenance and manual references.

No Icom manual PDFs, proprietary software, radio passwords or captured
credential packets are redistributed.

Local adaptations add optional replay grouping to session.sendCiv so the broker
can retire completed transactions at lease boundaries. The synthetic radio
fixture in tests/fixtures/icom-radio.js is adapted from PiRO's independent
fixture, with additions for native VFO reads and splitter tests.
