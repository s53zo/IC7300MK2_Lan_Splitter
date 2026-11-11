# Consolidated SWE audit — 2026-11-11

## Assessment

**Fixes recommended.** The normal paths are well covered and this audit found no introduced regression in the deferred-OFF-ACK change. However, a whole-product review found **10 actionable issues: four medium and six low**, plus separately classified design limitations and coverage gaps. None is classified critical/high from current evidence. The most useful first fixes are uninterrupted cleanup dispatch and truthful headless shutdown failure reporting. These were reproduced with isolated fixtures, not observed on the physical radio during this audit.

All six independent lanes completed: [A protocol/TX](reviewers/A-protocol-tx.md), [B cache/telemetry](reviewers/B-cache-telemetry.md), [C media/transport](reviewers/C-media-transport.md), [D interfaces/configuration](reviewers/D-interfaces-config.md), [E security/platform](reviewers/E-security-platform.md), [F adversarial/tests](reviewers/F-adversarial-tests.md). Their first passes preceded cross-review. The coordinator then reran all defect probes, inspected relevant source, checked the official Icom enum table, and reconciled duplicates and overstated interpretations. Reviewer test totals overlap and must not be added together.

This is an audit, not a fix delivery. Only this audit directory was added. No product code or dependency definitions were changed; no production service, pre-existing user configuration or production statistics were changed. No commits, pushes, releases, deployments or physical TX occurred. Fixture services/profiles were created, exercised and torn down only in isolated tests.

## Identity and evidence boundaries

- Local source and freshly read GitHub main: `ec801be1af4f0e05e5b156848541a788d7a704b0`; tracked worktree initially clean; package version still 0.8.1.
- Latest published release: [v0.8.1](https://github.com/s53zo/IC7300MK2_Lan_Splitter/releases/tag/v0.8.1), source `9d9e6661376601ce0b9a11aa9d9f1071ced4ef95`, published 2026-11-08, not a draft/prerelease. It has all three desktop installers, five standalone bundles, source archive and checksums. Current source adds Linux web management, telemetry, statistics reset and deferred-stop changes after that release. Published binaries must not be described as containing those changes.
- Freshly fetched [current Verify run](https://github.com/s53zo/IC7300MK2_Lan_Splitter/actions/runs/43094197886): six successful Node 22/24 jobs across Windows, macOS and Ubuntu. This is source-test evidence, not current native installer verification.
- Freshly fetched [v0.8.1 Release run](https://github.com/s53zo/IC7300MK2_Lan_Splitter/actions/runs/42516452856): all ten jobs succeeded, including native five-target builds, three desktop builds/smokes and draft preparation. This evidence belongs to the older release commit.
- **Current deployed identity/state unverified:** two read-only SSH attempts to the Pi timed out during banner exchange. A previous deployment record says ec801be, but it is not accepted as fresh runtime evidence. No attempt was made to restart/reconnect a service or create a radio association to overcome this limit.
- Local environment: macOS Intel, Node 26.13.0. Full 273 tests, lint, syntax checks and pack dry-run passed. Lockfile advisory lookup returned zero known advisories; that is not a security guarantee.
- New standalone executable and DMG were built in an isolated snapshot of ec801be. Standalone CLI, real-PTY TUI and native-client TUI smokes passed. The installed DMG loaded its real GUI but could not encrypt the fixture password because this session's macOS Keychain denied access (`errSecInteractionNotAllowed`, -25308); installed-GUI end-to-end behavior is therefore **not passed**.
- Ordinary HTTPS browser smoke passed with two synthetic clients, all 90 rendered settings fields, private replies, exact PCM/scope, settings persistence, reset confirmation, logout/close behavior and narrow layout. This tests the browser/server implementation on macOS fixtures; it is not a packaged Linux/systemd test.
- Capacity probes are short loopback workloads on this Mac. They are not Pi capacity limits, audible quality measurements or unrestricted client-count guarantees.

See [evidence.json](evidence.json), [verification guide](verification.md), [feature matrix](feature-matrix.md), and [90-field inventory](configuration-inventory.json).

## Confirmed actionable findings

Severity measures impact under the demonstrated trigger. All findings below have high confidence in the stated observation; production frequency is unmeasured. Source line references use audited HEAD. Detailed expected/actual behavior and commands are in the linked independent reports and runnable reproductions.

### AUD-01 — Medium: client reads can interrupt the cleanup sequence

**Locations:** `src/broker.js:568`, `:609`, `:670–676`, `:712–722`. **Trigger:** a VOX owner disconnects while another client has queued reads. After cleanup's initial PTT-off ACK, synchronous `receive().pump()` dispatches the next client read before the awaited cleanup continuation queues its next priority command. If that read stalls, its timeout resets upstream before VOX disable is sent.

**Expected/actual:** the safety cleanup sequence should reach initiator stops and fresh RX confirmation without unrelated work interleaving; observed trace is client `03` → cleanup `1c0000` → client `04` → timeout, with no `164600` and release=false. This is impaired cleanup progress, not a demonstrated false-success ACK or measured physical RF event. **Provenance:** pre-existing relative to ec801be; it does not disprove the latest deferred-ACK failure guards.

**Fix/test:** reserve dispatch for the entire release sequence, retaining permitted reads for later. Keep stop priority, cancellation and TX write restrictions. Test stalls at every cleanup step with readers from multiple clients, plus successful FIFO resumption. [A report](reviewers/A-protocol-tx.md); [probe](reproductions/A-release-read-interleave.js). Coordinator, C and F independently reproduced it.

### AUD-02 — Medium: legacy headless shutdown loses RX-confirmation failure

**Locations:** `src/broker.js:759–765`, `src/splitter.js:64–79`, `src/cli.js:110–117`. **Trigger:** SIGTERM while a fixture is keyed and rejects cleanup PTT-off. **Expected/actual:** explicit RX-unconfirmed warning and non-success outcome; observed process exit 0, empty stderr, fixture still keyed. Generic disconnected/failed status lines appear, but no explicit receive-unconfirmed warning. This applies to legacy environment/`--headless` shutdown; the web/controller wrapper has separate warning logic.

**Impact:** the caller cannot distinguish a confirmed release from failed cleanup using exit status. No software can guarantee stopping a radio that refuses commands; reporting that limitation truthfully is the fix. **Provenance:** pre-existing, also present in v0.8.1.

**Fix/test:** propagate release confirmation through Broker/Splitter close, warn and return nonzero on unconfirmed RX, retaining cleanup/lock/socket finalization. Test rejected stop, timeout, disconnect and successful shutdown in a real child process. [E report](reviewers/E-security-platform.md); [probe](reproductions/E-headless-failed-release.js). Coordinator, C and F confirmed.

### AUD-03 — Medium: upstream outstanding UDP sends lack an application cap

**Locations:** `src/icom-lan/stream.js:100–102`, `src/icom-lan/session.js:231–232`, `src/broker.js:625–632`. **Trigger:** an authorized TX source outpaces upstream send completion. Unlike downstream peers, upstream `raw()` submits without pending-byte accounting. The held-completion model accepts 10,000 packets representing 13,880,000 outstanding submitted bytes while replay correctly stays capped at 256.

**Expected/actual:** explicit application bounds and observable overload; no such bound exists on this path. **Limit:** those bytes are modeled submission lengths, not measured RSS/kernel backlog, and no production OOM was established. **Provenance:** pre-existing initial transport path.

**Fix/test:** cap outstanding media submissions, track completions/errors/drops, and retain safety-control progress. Generation-tag any application-owned queue; already-submitted datagrams cannot be recalled. Add stalled/error completion and lease-transition tests. [C report](reviewers/C-media-transport.md); [probe](reproductions/C-transport-probes.js). Coordinator reproduced the modeled absence of a bound.

### AUD-04 — Medium: media-only loss beyond half the sequence space delays recovery

**Locations:** `src/icom-lan/protocol.js:44–45`, `src/icom-lan/stream.js:136`, `:177–185`, `:223–249`. **Trigger:** payload sequence advances more than 32,767 positions while media is lost but pings still arrive. After delivered sequence 1, recovered packets 40,000–40,999 are all classified as duplicates; no failure/reconnect is requested.

**Expected/actual:** bounded recovery after media returns; healthy heartbeat keeps the stuck stream alive until sequence wrap restores ordering. This is a narrow, long-outage case: at 100 packets/s, more than about 5.5 minutes of selective media loss; resuming at 40,000 can add about 4.25 minutes before normal acceptance. It is not permanent silence or proof of the station's earlier short dropouts. **Provenance:** pre-existing initial sequence logic.

**Fix/test:** distinguish payload progress from heartbeat liveness and safely renew the association on a sustained unusable sequence window. Do not blindly move the receive watermark: that risks accepting replayed TX/control. Test long selective loss, normal wrap, silence and stale old associations. [C report](reviewers/C-media-transport.md); [probe](reproductions/C-transport-probes.js). Coordinator reproduced.

### AUD-05 — Low: automatic recovery erases transport history

**Locations:** `src/icom-lan/session.js:62–72`, `src/icom-lan/stream.js:24`, `src/broker.js:152–157`. New stream objects start at zero, and metrics expose only those objects. Real loopback probes show malformed/duplicate totals 1→0 after automatic reconnect while physical command totals persist.

**Expected/actual:** statistics since the latest reset should remain monotonic across reconnects; transport evidence disappears without a reset. **Impact:** misleading diagnostics, not incorrect media delivery. **Provenance:** pre-existing `5dae6cf`.

**Fix/test:** fold retired-stream counters into cumulative totals, preserve current gauges, and reset both banks atomically. Test repeated automatic recovery plus reset-before/during recovery without double counting/resurrection. [B](reviewers/B-cache-telemetry.md), [F](reviewers/F-adversarial-tests.md); [B probe](reproductions/B-statistics-boundaries.js), [F failing invariant](reproductions/F-transport-reconnect.js). Independent B/F discoveries; coordinator reproduced both.

### AUD-06 — Low: Stop/Reconnect erases admission history

**Locations:** `src/app/controller.js:175–180`, `:218–223`, `:279–285`; admission source `src/cli.js:66–74`. AppController retains cache and metrics, but not admission events. Actual loopback pre-auth expiry 1→0 across reconnect with unchanged statisticsStartedAt; a second controller probe demonstrates all three admission counters disappearing.

**Expected/actual:** preAuthExpired/preAuthEvictions/resourceRejects should survive within the statistics window; their history is lost. **Provenance:** pre-existing application aggregation (`9bc11de`).

**Fix/test:** accumulate admission events separately from live counts, include them in reset, and verify Stop/Start plus repeated reconnect/reset. [B](reviewers/B-cache-telemetry.md), [D](reviewers/D-interfaces-config.md); [B probe](reproductions/B-statistics-boundaries.js), [D probe](reproductions/D-interface-probes.js). Independent B/D findings; coordinator reproduced.

### AUD-07 — Low: TUI announces successful Start/Reconnect after failure

**Locations:** `src/app/tui.js:237`, `src/app/controller.js:170–184`. Controller returns a stopped/error state rather than throwing on some startup failures; TUI unconditionally prints Started/Reconnected. The isolated probe shows running=false and lastError set beside the success message.

**Expected/actual:** truthful result feedback; immediate TUI message contradicts actual state. Dashboard/diagnostics still reveal failure, limiting severity. **Provenance:** pre-existing relative to latest ACK change; exact introduction not assigned.

**Fix/test:** derive feedback from returned state/error and distinguish connecting from ready. Test both failed Start and failed Reconnect with a controller that resolves failure state. [D report](reviewers/D-interfaces-config.md); [probe](reproductions/D-interface-probes.js). Coordinator reproduced.

### AUD-08 — Low: IF-filter-shape cache validation accepts unsupported replies

**Locations:** `src/read-cache.js:30–32`, `tests/read-cache.test.js:65`. [Official Icom CI-V guide, page 6](https://icomuk.co.uk/files/icom/PDF/productAdditionalFile/IC-7300MK2_ENG_CI-V_0.pdf#page=6) defines only 00/01 for `1656`; validator accepts BCD 0–31 and its test endorses 31. Injected value 02 is shared to two clients from one physical read.

**Expected/actual:** reject unsupported values from cache population/coalescing; malformed value is amplified during the TTL. This requires a faulty reply; no evidence normal firmware emits it, and the getter does not transmit. **Provenance:** pre-existing `d2c6131`.

**Fix/test:** limit this binary enum to 0/1, correct the positive oracle, reject 02/31 and ensure a second client performs a physical read after an invalid first reply. [B report](reviewers/B-cache-telemetry.md); [probe](reproductions/B-read-cache-shape.js). Coordinator checked primary manual and reproduced.

### AUD-09 — Low: telemetry misses have no detailed reason

**Locations:** `src/broker.js:433–451`, `src/telemetry.js:99–114`, `src/metrics.js:20–22`. Cold 1502 fallback increments cache misses/fallbacks to 1, but every miss-reason counter remains 0 because telemetry bypasses cachedReply's instrumentation.

**Expected/actual:** bounded absent/expired/ordering reason for an eligible fallback; detailed reason totals under-report it. The physical read and value delivery remain correct. **Provenance:** shared telemetry `47cf947`, predating current HEAD.

**Fix/test:** report the lookup failure reason once at actual fallback dispatch, honoring reset suppression. Test cold, stale, epoch barrier and reconnect fallbacks. [B report](reviewers/B-cache-telemetry.md); [probe](reproductions/B-statistics-boundaries.js). Coordinator reproduced.

### AUD-10 — Low: package instructions link to omitted service files

**Locations:** `scripts/release-build.js:65–67`, `scripts/desktop-build.js:22–27`, `docs/operations.md:108`, `:125`, `:140`. Fresh current standalone archive includes operations instructions but no docs/services templates; the new Linux web guide is also outside the standalone allowlist. Desktop staging omits the same linked templates.

**Expected/actual:** included service instructions should have corresponding files or explicit source-download links; offline users must find/reconstruct missing files. Runtime execution is unaffected. **Provenance:** service-template omission also exists at v0.8.1; web-guide omission belongs to later web functionality.

**Fix/test:** ship the small guide/template set or point explicitly to corresponding-source files; include Linux web setup in new Linux bundles. Assert all packaged relative installation links resolve. [E report](reviewers/E-security-platform.md). Coordinator inspected the fresh executable archive, not stale local builds.

## Risks and limitations, not added to the defect count

1. **Previously unseen old audio can enter a later legitimate TX lease on the same native association.** F's real UDP probe reproduces it; it cannot start TX by itself. This boundary is explicitly documented in `docs/architecture.md:111–116`. Native packets have no TX-epoch ID. Guaranteed exclusion requires association rotation/client cooperation with reconnect/compatibility costs; quarantine/age heuristics only mitigate. [F](reviewers/F-adversarial-tests.md), [probe](reproductions/F-delayed-audio-lease.js); C/coordinator corroborated.
2. **Helper-local generation gaps.** A fault immediately after a CW-mode reply can leave an old continuation queuing 17ff under a new generation. Current synchronize() calls lost() and purges it; no unsafe send or stale success was demonstrated. Add fences and fault-boundary tests when touching cleanup, without reporting the queue observation as a proven RF defect. [A probe](reproductions/A-generation-boundary.js).
3. **Interrupted save is not a crash-atomic settings/credential transaction.** Real temporary-file stores plus a killed fixture subprocess reload old username/new password. Ordinary caught-error rollback works; process death cannot run it. Decide desired recovery semantics before a journal/generation design. This is a demonstrated crash window with unmeasured incidence, separately classified from normal persistence failures. [D](reviewers/D-interfaces-config.md).
4. **BFCache restoration is modeled only.** pagehide sets stopped forever and there is no pageshow recovery. A VM event probe shows the JS state issue, but supported-browser restoration with pageshow.persisted was not established. Confirm real reachability before promoting to defect. [D](reviewers/D-interfaces-config.md).
5. Native LAN is a trusted-local-network protocol, not end-to-end encrypted per-client authorization. Shared credentials/control and front-panel concurrency are deliberate boundaries. No demonstrated management auth bypass was found; zero advisory matches is not proof of absence of vulnerabilities.
6. Actual physical CW/VOX/tuner/voice-memory/RF unkeying, current Pi health, audible quality, firmware-specific replies, long soak, hostile sustained load, native Windows/ARM current installers, minimum OS versions and Linux packaged web/systemd remain unverified in this audit. Prior hardware records were inspected as historical evidence only.

## Decisions and proposed order

1. Address AUD-01/AUD-02 together first, retaining deferred ACK and refusal-on-failed-RX semantics; add helper generation fences and regressions in that bounded cleanup work.
2. Address AUD-03/AUD-04 with transport/replay-aware tests. Changing association recovery affects all clients; avoid quick watermark resets or indiscriminate control drops.
3. Restore diagnostic history (AUD-05/AUD-06), then narrow validation/UX/instrumentation/package fixes (AUD-07–AUD-10).
4. Recheck current-source Linux packaged web, Windows/macOS ARM native builds and an interactive macOS Keychain session before a new release. Publish an identifiable new version only after the owner chooses fixes and authorizes release; current source and v0.8.1 binaries differ.

See [proposed-fixes.md](proposed-fixes.md) for effort, compatibility risks, regressions and acceptance gates. All implementation/deployment decisions remain with the owner.
