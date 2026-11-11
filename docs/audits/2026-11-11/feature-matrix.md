# Feature inventory and verification matrix

Scope: source ec801be, 2026-11-11. Expected behavior derives from the user's audit requirements plus `README.md`, `docs/architecture.md`, `docs/operations.md`, `docs/interfaces.md`, `docs/linux-web-service.md` and `docs/releases.md`. Official CI-V details checked are identified explicitly below. Runtime/platform scope is a column, not implied by a passing unit test.

- **Verified** means the stated local fixture/source property passed; it never means universal hardware certification.
- **Failed** means an explicit desired property has a demonstrated counterexample.
- **Partially verified** means useful source/test evidence exists but a relevant end-to-end or fault boundary remains open.
- **Unverified** means the required platform/hardware/runtime evidence was unavailable.
- Test abbreviations in this table mean `tests/<name>.test.js`. Reproduction IDs refer to [verification.md](verification.md); AUD IDs refer to [report.md](report.md). Individual matrices in reviewers A–F provide finer source-line/test detail and provenance.

## Native LAN and command handling

| Feature / expectation | Implementation | Existing checks | Added verification | Result and scope |
| --- | --- | --- | --- | --- |
| One upstream association for multiple clients (README/architecture) | splitter, icom-lan/session, server | integration, server, release | Fresh CLI/native-TUI/browser smokes; C load | Verified loopback; current Pi unverified |
| Authentication, tokens, renewal, logout and expiry | icom-lan/protocol/session, server | protocol, server, integration | E/A caller review | Verified encoded/UDP fixture paths; third-party current-client behavior unverified |
| Same-IP clients have distinct media/control sessions | server | server, integration | Two-client smokes, 8/32/128-client fixtures | Verified loopback associations |
| Malformed/unauthed/preauth traffic cannot create unlimited clients | server, protocol, config | server, protocol | E admission and cap-path review | Verified modeled limits; sustained hostile LAN stress unverified |
| Native codec 4, mono16/48k only; reject unsupported formats | protocol, server, session | protocol, server | C byte/format review | Verified fixtures; no other codec claimed |
| One pending CI-V transaction; private requester routing with shared controller address | broker | broker, integration | New read/restore and cross-feature probes; packaged smokes | Verified tested FIFO/address cases |
| Ordinary RX commands preserve arrival order; urgent stop exception explicit | broker command/pump | broker, cache-broker, telemetry-audit | A source/queue review | Verified ordinary FIFO; cleanup sequence defect AUD-01 |
| Frame fragments/noise/echo/unrelated replies cannot complete wrong request | broker FrameParser/receive | broker, cache-broker, protocol | A/F parser/oracle review | Verified tested bounded inputs; complete fuzzing unverified |
| Global/per-client command caps and urgent-stop admission | broker command/reject | broker, broker-metrics | A source review and queued-read cleanup probe | Verified ordinary caps/first-stop priority; subsequent cleanup priority fails |
| Radio-model address selection, broadcast/setter state fanout | broker synchronize/broadcastState | broker, integration | A review selected/unselected VFO callers | Verified fixture layouts, not all firmware variants |
| Shared scope output remains enabled regardless of one client subscription | broker synchronize/pump/receive | broker, integration | Fresh exact-scope smokes and C load | Verified emitted scope bytes; real waterfall rendering unverified |

## TX and asynchronous lifecycle

| Feature / expectation | Implementation | Existing checks | Added verification | Result and scope |
| --- | --- | --- | --- | --- |
| PTT ownership, private ACK and competing-client TX rejection | broker classify/pump/receive/audio | broker, integration, app-native | Fresh native-TUI synthetic TX flow | Verified fixtures; no RF |
| CW text, bounded completion, CW/CW-R stop and USB non-CW cleanup | broker classify/stopKeyer/poll | broker, safety-poll | A helper-generation boundary probe | Partially verified; helper continuation gap separately recorded |
| VOX enable/disable, microphone gate, PTT+VOX partial stop | broker triggers/lease/audio | broker, safety-poll | A VOX-owner disconnect with stalled reader | Partial; normal semantics pass, cleanup progress fails AUD-01 |
| Tuner automatic start/stop/completion and coexistence | broker classify/stopInitiators/poll | broker, safety-poll | A initiator matrix/source review | Verified modeled states; real tuner/RF unverified |
| Voice/voice-repeat initiator and simultaneous triggers | broker classify/triggers/poll | broker, safety-poll | A init/stop source and test review | Verified fixture cases; physical playback/repeat unverified |
| Reject/discard competing changes during TX and all writes during release | broker allowed/command/release | broker, integration | Deferred-OFF regression includes competing 0084 write | Verified fixture restrictions; no queued replay observed |
| Owner disconnect/heartbeat timeout retires work and attempts cleanup | broker disconnect/release, server timeout | broker, server, integration | A/E real-failure probes | Partial: cleanup ordering AUD-01; physical unkeying unverified |
| Lease-ending OFF success ACK follows cleanup and confirmed RX | broker deferStopReply/release | broker | Independently rerun deferred ACK/0084 regression and failure cases | Verified fixtures at audited HEAD |
| Immediately read and restore 0084 after deferred OFF ACK | broker queue/receive/release | broker | Exact read/write ordering regression | Verified in-process; current Pi/PiRO end-to-end unverified |
| No false success after cleanup NG, TX-still-active, reset, media/session change | broker deferredStops/cancelAll/lost | broker, statistics-reset | A/F source review; targeted deferred tests | Verified tested fixture boundaries |
| Explicit release boolean and deferred logical completion/cancellation | broker release, metrics | broker, broker-metrics | E rejected-stop child process | Release bool verified; legacy close propagation fails AUD-02 |
| Generation guards around every cleanup await | broker synchronize/stopKeyer/stopInitiators | broker failure/replacement tests | A-generation-boundary | Partially verified: nested helper gap; no unsafe send proven |
| Stop/close/reconnect TX confirmation includes pending/queued triggers | controller, TUI, renderer | app-controller, app-native, tui | Native-TUI synthetic cancel/confirmed close | Verified fixtures; physical gate race unverified |
| Legacy headless graceful shutdown reports failed RX confirmation | broker.close, splitter.close, cli stop | operations normal shutdown | E-headless-failed-release | Failed AUD-02; web/controller wrapper evaluated separately |
| Local radio/profile locks and stale-owner recovery | app/lock, controller, cli | app-controller, operations | E lock caller review | Verified local OS/fixtures; no cross-host exclusive lock claimed |

## Cache, coalescing and shared telemetry

| Feature / expectation | Implementation | Existing checks | Added verification | Result and scope |
| --- | --- | --- | --- | --- |
| Narrow allowlist of read shapes, no credential-adjacent menus | read-cache policyFor/validReply | read-cache, cache-broker | B full map review; query-inventory.json | Partially verified: enum defect AUD-08; not every getter manually certified |
| Family TTL defaults 100/100/250/50ms | read-cache, config/settings | read-cache, config, cache-broker | B config/source review | Verified fixtures |
| Per-query blank inheritance, positive override and zero opt-out | read-cache, config, settings/UI | read-cache, config, app-settings | Browser smoke actual-read counts for blank/0/200 | Verified browser/fixture paths |
| Global cache off disables cache/coalescing AND shared telemetry | broker, telemetry.active | cache-broker, telemetry | B review; corrected C load configuration | Verified; original C telemetry inference explicitly withdrawn |
| Duplicate queued reads coalesce with private reply addresses | broker cachedReply/rememberReply | cache-broker, cache-integration | B malformed-enum amplification probe | Verified ordinary coalescing; invalid enum can be shared AUD-08 |
| Mutation admission/dispatch/outcome, notification and lifecycle invalidate samples | broker, telemetry | cache-broker, telemetry-audit | B epoch/call-chain review | Verified covered barriers |
| Cached reads do not bypass prior writes or safety poll position | broker pump/internal | cache-broker, telemetry-audit | A/F queue review | Verified normal barriers; release exclusivity separate AUD-01 |
| S-meter/RXTX schedule target100ms; ADC target500ms | telemetry definitions/tick | telemetry, telemetry-audit | Corrected C load asserts active sampler | Verified target constants/bounded fixture scheduling; current hardware cadence unverified |
| Power/SWR/ALC target100ms only on fresh confirmed TX | telemetry actualTx/entry/tick | telemetry, telemetry-audit | B primary-manual/state review | Verified fixtures; physical TX scheduling unverified |
| Locally generated zero TX meters need fresh confirmed RX | telemetry lookup | telemetry, telemetry-audit | Official Icom CI-V p5 (PDF index4) confirms zero-on-RX | Verified documented value semantics + fixture age guards |
| Cold/stale/epoch ordering fallbacks read radio normally | telemetry lookup/prepareFallback, broker | telemetry, telemetry-audit | B-statistics-boundaries | Values/dispatch verified; detailed reason instrumentation fails AUD-09 |
| Per-key bounded jobs, max-age limits, no catch-up bursts | telemetry jobs/nextDue/tick | telemetry, telemetry-audit | B scheduler review and active C concurrent load | Verified modeled bounds; real slow-radio timing unverified |
| Safety checks use fresh physical RX/TX reads and stable-RX release window | broker poll, telemetry safety job | safety-poll, telemetry-audit | A/B review ownership/incarnation guards | Verified fixtures; no physical safety certification |

## Media and resource handling

| Feature / expectation | Implementation | Existing checks | Added verification | Result and scope |
| --- | --- | --- | --- | --- |
| Exact RX PCM and full scope payload fanout | broker/server, session | integration, server, protocol | CLI/browser/native-TUI smokes; C 8/32/128 workloads | Verified emitted bytes/packets on loopback; audible quality unverified |
| Ordinary sequence wrap, duplicates, gap reorder and replay | stream, protocol | protocol, integration | C offline wrap [65534,0,65535,1] | Verified modeled windows; half-space recovery fails AUD-04 |
| Reconnection after control/stream failure | session, stream, broker | integration, broker, operations | F/B actual automatic reconnect/media resume | Verified fixture recovery; transport history fails AUD-05 |
| Recovery from media-only outage while pings survive | stream ordered/tick | Existing tests cover shorter ordinary gaps | C long-media-blackhole | Failed narrow long-outage case AUD-04 |
| Downstream replay/reorder/pending sends are bounded; slow peer isolated | server Peer, stream | server, protocol | C held completions: 2808B/998 drops vs1000 healthy packets | Verified application model; actual shared-NIC congestion unverified |
| Upstream outstanding media send bound | stream.raw, session.sendAudio | Existing replay tests do not assert pending bytes | C held upstream completions | Failed application bound AUD-03; no OS memory measurement |
| Known/observed old keying/audio retired at lease boundary | server.retireInbound, broker.invalidateTx | broker, server, protocol | F real-UDP unseen-datagram probe | Observed watermark behavior verified; unseen-packet documented limitation |
| Previously unseen delayed PCM cannot be identified by lease on same association | native wire format, server/broker | Architecture explicitly limits guarantee | F-delayed-audio-lease expected invariant fails | Confirmed documented limitation, not unexpected new defect |
| Moderate concurrent controls + ACTIVE sampler preserve media | shared event loop, independent UDP streams | integration provides lighter baseline | Corrected C-concurrent-media, 8 clients | Verified 3s workload only; no long-soak guarantee |
| Resource scaling with elevated admission budget | server budgets, broker caps | server, benchmark | C32/128client 2s loopback | Verified short configured workload; not default admission or Pi capacity |
| LanCapture/LanPlayback sample clocks, underrun/overflow/drain | icom-lan/audio | No direct dedicated audio-class tests | C source review distinguishes bypassed native forwarding | Partially verified; audio-class timing/sound unverified |

## Interfaces, configuration and statistics

| Feature / expectation | Implementation | Existing checks | Added verification | Result and scope |
| --- | --- | --- | --- | --- |
| All90 schema controls/defaults; numeric validation, IPv4/ports/loop prevention | settings, config, GUI/TUI fields | app-settings, config, tui | Browser renders90; complete configuration-inventory.json; D schema review | Verified representative/looped validation; not exhaustive all field combinations |
| All allowlisted query controls/configuration discovery | settings, read-cache catalog, store | app-settings, read-cache, tui | Query inventory; standalone help/config smokes | Verified schema/catalog; compatibility of every firmware enum not claimed |
| Separate credential persistence, private POSIX files, imports/redaction | app/store, controller, desktop credentials | app-settings, desktop-security, app-controller | D interrupted-save subprocess | Normal/error rollback verified; crash-atomic pair is separate risk |
| Real macOS Keychain encryption and Windows OS vault | desktop/main DesktopCredentials | desktop-security mocks | Fresh installed DMG save attempted | Unverified end-to-end: local Keychain access denied; Windows native not run |
| Saved vs active settings; defaults/save/apply reconnect | controller, renderer, TUI | app-controller, app-settings, tui | Browser saves/defers/cancels/applies per-query lifetime | Verified fixture normal paths |
| Truthful TUI Start/Reconnect result | tui requestAction, controller | tui normal-action tests | D actual controller failure probe | Failed AUD-07 |
| HTTPS management available while radio is unreachable | web/main/server, controller | web-main, web-server | Browser fixture boot/auth state | Verified isolated server behavior; Linux service deployment unverified |
| Linux-only web entry, management port and custom TLS/bind options | cli, web/main/tls | config, web-main | E source/asset/CLI review | Verified rejection/selection fixtures; packaged Linux web not executed |
| Bootstrap/login/credential-change revocation/logout/session expiry | web server/main/login/bridge | web-server, web-main, web-frontend | Ordinary browser setup/login/wrong password/signout | Verified fixtures; deployed endpoint unavailable |
| Host/Origin/CSRF, allowlisted actions/assets/body/rate/session caps | web/server | web-server | D/E validation/caller review | Verified modeled TLS/HTTP attacks; sustained hostile load unverified |
| TLS generation, reuse, renewal, custom pair validation | web/tls | web-main | E review and actual TLS fixture requests | Verified OpenSSL/test paths; deployed cert unverified |
| Browser close/sign-out preserve service | web bridge/main/server | web-frontend, web-main, web-server | Ordinary browser close/signout smoke | Verified fixture lifetimes; BFCache restoration risk modeled only |
| Desktop navigation/CSP/main-frame IPC/permission boundary | desktop main/security/preload | desktop-security | E/D source review; real DMG bootsGUI | Partially verified: isolated IPC assertions; native session save blocked |
| TUI five views/password masking/export/raw mode/terminal restoration | app/tui | tui | Fresh packaged real PTY and native-TUI smokes | Verified macOS explicitTUI; Linux no-argument mode only historical CI |
| Dashboard/client readiness, TX owner, age, ping vs response vs queue | controller, renderer/TUI, stream | app-native, ping, ping-native, app-controller, telemetry-ui | Browser/native-TUI measured ping and exact client count | Verified fixtures; actual RF/playback delay not measured |
| Cache-hit denominator/coalesced subset/physical traffic distinction | broker metrics, controller, renderer | broker-metrics, metrics, telemetry-ui | B/D code review, corrected concurrent-load counters | Verified normal covered counters; no net-RF savings claim |
| Cache/physical/logical totals across explicit reconnect | controller combineCache/combineMetrics | app-controller | B/F reconnect probes | Verified tested cache/physical sums; transport/admission exceptions below |
| Transport history across automatic reconnect | broker/session snapshots | Existing tests omit conservation | B/F real parser/reconnect probes | Failed AUD-05 |
| Admission history across Stop/Start/reconnect | controller rawState/totals | Existing cache accumulation tests do not cover admission | B actual server + D controller probe | Failed AUD-06 |
| Detailed telemetry miss reasons | broker/telemetry/metrics | Telemetry tests assert totals only | B cold-fallback reason probe | Failed AUD-09 |
| Reset zeroes counters/rates/history, preserves cache/clients/TX/schedule | controller/broker/telemetry reset | statistics-reset, app-controller, broker | Browser confirm/cancel/reset; deferred-stop reset test | Verified isolated pending/queued/deferred/TX cases; no production reset |
| True service uptime, live gauges,15min history and reset timestamp | controller.sample/getState, TUI/renderer | app-controller, tui | D review, browser reset/labels | Verified fixture measurements, not audible latency |
| Redacted diagnostic export and bounded events/history | controller/desktop security/TUI/bridge | app-controller, desktop-security, tui, web-server | Browser download, packaged TUI export | Verified synthetic secret redaction; exported operational info intentional |

## Platform, distribution and supplementary tools

| Feature / expectation | Implementation | Existing checks | Added verification | Result and scope |
| --- | --- | --- | --- | --- |
| Windows x64 standalone and installer | release workflow/builders | release, release-archive; current-source Windows CI | Inspected older release successful native jobs/assets | Partially verified; current native installer not executed |
| macOS Intel standalone and DMG | release/desktop build/smoke | release, release-archive, desktop-security | Fresh isolated builds, signing checks, CLI/TUI smokes, installed GUI attempt | CLI/TUI verified; GUI complete flow unverified due Keychain |
| macOS ARM standalone and DMG | release workflow | Older v0.8.1 native release jobs | Current source reviewed; older assets exist | Unverified current native build/runtime |
| Linux x64/ARM64 standalone, default TUI, headless and web | release assets/cli/web | Current-source Ubuntu CI; older native release/TUI jobs | Source browser and macOS explicitTUI smokes | Partial: current packaged Linux web/defaultTUI not executed |
| Service templates, systemd/launchd/Task Scheduler, boot policy | docs/services, operations/web guide | operations verifies process, not real service manager | E manifest review; live SSH unavailable | Unverified current service runtime; package docs fail AUD-10 |
| Local duplicate-instance locks and graceful shutdown | lock/controller/cli/splitter | app-controller, operations | E child failed-release probe | Normal locks verified; legacy shutdown reporting fails AUD-02 |
| Source identity, version checks, checksums, deterministic archive safety | release-meta/build/archive/publish | release, release-archive | Fresh BUILDmetadata/ec801be vs release9d9; SHAchecked official Node | Verified local builder/archive logic and fetched release metadata |
| Draft-only release creation and no auto-publish | release-publish, workflow | release tests | E review; published-release identity inspected | Verified logic review; no publish executed |
| Service installation docs resolve within binary bundles | release/desktop allowlists | Existing archive tests omit relative-link check | Fresh archive listing | Failed AUD-10 |
| Unsigned Windows/ad-hoc Mac without notarization intentional | builders, docs/releases | release/build metadata | Fresh ad-hoc signing, no notarization | Verified intended policy, not a defect |
| Minimum OS/runtime compatibility | engines, builders, docs/releases | Matrix tests Node22/24/current runners | Current localNode26 + officialNode build | Partial; minimumOS/firmware combinations unverified |
| No runtime npm deps; pinned development tooling | package/lockfile | release bundler rejects external requires | Fresh npm audit zero advisories, pack dry-run | Verified current manifest/advisory query; not no-vulnerability certification |
| wfweb interoperability/hardware/probe helpers | scripts/wfweb-smoke/hardware-smoke/telemetry-probe/telemetry-tx-test | telemetry-probe, telemetry-tx-test; historical docs/results | Reviewed history/tool boundaries; helpers not run on radio | Partially verified unit/helper behavior; current third-party real-client interoperability unverified |
| Architecture, operations/research/licensing and corresponding source | docs, NOTICE, LICENSE, third_party, source release | release tests/archive contents | E/C/A documentation crosscheck, officialCI-V enum/RXzero | Partial: README no-web sentence stale, net-savings wording predates telemetry; source/release features differ |
