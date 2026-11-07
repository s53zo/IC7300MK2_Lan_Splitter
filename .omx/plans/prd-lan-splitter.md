# Implementation plan

Requirements source: ../specs/deep-interview-lan-splitter.md.

## Decisions
Use Node.js >=22 built-ins (UDP, events, crypto, test runner), CommonJS, no runtime package dependencies. Reuse PiRO LAN transport with AGPL-3.0 licensing and explicit upstream GPL provenance. Avoid PiRO's application driver, UI, audio processing and automatic setting changes: a transparent splitter must relay native commands, not take over client policy.

## Stages
1. Preserve protocol provenance; import proven packet/session/stream/audio primitives. Inspect and repair transport assumptions at server boundaries.
2. Implement command broker: frame parsing, ordered transactions, requester reply routing despite common CI-V addresses, broadcast state/scope distribution, exclusive TX leases, disconnect release confirmed by TX-state read, stale-reply isolation via upstream reset.
3. Implement native downstream server: full handshake/login/token/capabilities/grant, authenticated requested-port association (not IP-only), per-stream sequence/replay state, heartbeat expiry, bounded queues and explicit codec negotiation. Start with radio-supported PCM4/48kHz and investigate other native formats before declaring compatibility.
4. Compose upstream, downstream and broker into service with secure runtime credential intake, configuration validation, reconnect, shutdown, diagnostics and cross-platform launch/service instructions.
5. Build independently encoded synthetic radio/client harness plus unmodified PiRO interoperability. Exercise transport faults, concurrent clients and TX lifecycle; measure fanout capacity. Investigate available wfweb/wfview launch surfaces for unmodified interoperability.
6. Verify source, tests, packaging, local CLI lifecycle and native-client interoperability. Add multi-OS CI. Establish radio availability before real connection and dummy-load readiness before RF tests. Document actual coverage and outstanding external validation.

## Invariants
One upstream session; no old writes after reconnect; no competing TX audio; client death releases keying before handover; no global codec mutation by one client; no password persistence/logging; no sibling edits. Do not imply Internet-grade encryption (native protocol obfuscates credentials only).
