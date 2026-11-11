# Reviewer E — security, lifecycle, packaging and platforms

Date: 2026-11-11. Independent first-pass assessment of local source `ec801be1af4f0e05e5b156848541a788d7a704b0` (package 0.8.1), before receiving other reviewers' findings. The initial tracked worktree was clean. Reviewer-owned additions are this report and `reproductions/E-headless-failed-release.js`. No implementation changes, production access, network calls, commits, builds requiring downloads, or deployments were performed by this lane.

## Assessment

The inspected management boundaries are deliberately narrow: HTTPS in production, exact Host/port and Origin checks, per-session CSRF, bounded bodies/sessions/requests, short-lived server-side session tokens, controller-level secret redaction, and a desktop IPC allowlist tied to the application's own main frame. Native client admission and peer state have explicit bounds. I found no demonstrated authentication bypass, arbitrary server file access, code execution, or cross-client media association bypass in this lane.

One medium defect was reproduced: legacy headless shutdown loses TX cleanup failure and returns exit status 0. One low packaging defect follows directly from the staging manifests: included installation documentation links to omitted service templates. The positive tests below establish fixture behavior on this macOS host; they do not establish physical radio safety or all supported operating-system floors.

## Confirmed defects

### E-1 — medium, high confidence: headless shutdown reports process success after failed TX cleanup

**Feature and evidence:** `src/broker.js:759` awaits `release()` but discards its boolean; `release()` returns false after a rejected cleanup or failed receive confirmation at `src/broker.js:669`–`src/broker.js:692`. `src/splitter.js:64`–`src/splitter.js:79` forwards no cleanup result. The legacy headless signal handler at `src/cli.js:110`–`src/cli.js:117` awaits `service.close()` without reporting a failed release or setting failure status. The Linux web wrapper has an explicit receive-unconfirmed warning path at `src/web/main.js:68`–`src/web/main.js:74`; this particular finding applies to legacy `--headless`/environment mode.

**Trigger / reproduction:** Run from the repository root:

```sh
node docs/audits/2026-11-11/reproductions/E-headless-failed-release.js
```

The script strips inherited `ICOM_` environment entries, creates one synthetic radio on ephemeral loopback UDP ports, starts a child headless CLI with a synthetic password, authenticates one fixture client, and requests synthetic PTT. It then makes the fixture reject exactly the shutdown PTT-off command (`1C 00 00`) with CI-V NG and sends SIGTERM to the child. No real radio, RF, credentials, or saved profile is used.

**Observed:** Node 26.13.0 / macOS: `rejectedStops=1`, `simulatedRadioStillTransmitting=true`, `exitCode=0`, `stderrEmpty=true`, `explicitReceiveUnconfirmedWarning=false`. Output contains “Stopping; releasing radio transmission if connected.” followed by generic `Radio: disconnected` and `Radio: failed` status messages. Those generic messages are evidence of an upstream failure, but do not identify that receive state remains unconfirmed. The reproduction asserts the specific lack of an RX warning; its original broad warning regex matched the generic word “failed” and was tightened before this report.

**Expected versus actual / impact:** Failure to confirm RX should reach the process owner as an explicit warning and non-success outcome. The process instead exits successfully even though the simulated radio is still keyed. A supervisor or operator using exit status cannot distinguish this from safe shutdown; `Restart=on-failure` will not classify this stop as a process failure. The splitter cannot force a radio that refuses stop into RX; the defect is lost failure reporting, not proof that software can guarantee unkeying after link/radio failure.

**Provenance:** Pre-existing relative to the latest source change. Local `git show 9d9e666:src/broker.js` and `git show 9d9e666:src/cli.js` contain the same discarded-result path. Commit `9d9e666` was identified by the coordinator as the published v0.8.1 source. Physical-radio consequences were not tested.

**Smallest fix / regression:** Preserve an explicit `{ releaseConfirmed }` or equivalent result through Broker/Splitter close and emit a sanitized “receive state could not be confirmed; check the radio” error with nonzero exit status in legacy CLI mode. Do not claim that nonzero exit proves unkeying. Extend `tests/operations.test.js` with rejected-stop, cleanup timeout and disconnect-during-release child-process scenarios; assert RX-confirmation failure is exposed, child exits, sockets close, and successful shutdown still exits 0. Keep the web/controller shutdown behavior consistent.

### E-2 — low, high confidence: shipped service instructions reference files excluded from binary packages

**Feature and evidence:** The standalone allowlist at `scripts/release-build.js:65` includes `docs/operations.md` but omits `docs/services/` and `docs/linux-web-service.md`. The desktop allowlists at `scripts/desktop-build.js:22`–`scripts/desktop-build.js:27` have the same service-template omission. Included `docs/operations.md:108`, `docs/operations.md:125`, and `docs/operations.md:140` instruct users to copy/link the systemd, launchd and PowerShell templates from `docs/services/`. The new Linux web setup guide and `icom-lan-splitter-web.service` are not staged by the standalone builder either.

**Trigger / expected versus actual:** Extract a generated standalone archive and follow its included `docs/operations.md` service installation instructions offline. The referenced `docs/services/icom-lan-splitter.service`, `local.icom-lan-splitter.plist`, and `Start-Splitter.ps1` are absent. Expected: referenced templates ship with installation documentation, or the documentation explicitly directs users to the exact source download. Actual: users must obtain the missing files separately or reconstruct them. The runtime executable and source archive are not shown to be broken by this omission.

**Proof / provenance:** Confirmed by current explicit staging manifests, and the same standalone allowlist exists at local release commit `9d9e666`. Existing original-workspace 0.1.0 artifacts also omit these templates, but they are stale and are not evidence for the contents of a new 0.8.1/current build. After this independent first pass, the coordinator confirmed the same omission by inspecting the docs list in a fresh source-`ec801be` macOS Intel standalone archive. This is artifact corroboration of the manifest finding; Linux archive contents were not inspected by this lane.

**Smallest fix / regression:** Add the bounded service-template directory and Linux web guide to the package allowlists, retaining the instruction to adapt Node/executable paths. Alternatively amend the packaged guide to point to corresponding-source files. Add a package-content check that every local installation link in shipped documentation resolves inside the package. No signing/notarization change is proposed.

## Risks and coverage gaps, not confirmed vulnerabilities

- **Multi-file save crash consistency:** `src/app/store.js:57`–`src/app/store.js:68` saves credentials before atomically replacing settings and rolls back on a caught settings-write error. Abrupt process or machine death between these two writes can leave old settings with new credentials; individual file rename does not make the pair transactional. Existing `tests/app-settings.test.js:64` exercises a caught failure, not crash recovery. Consider a crash-injection test and an explicit recovery design if atomic profile updates are required. No simulated machine failure was performed, so this is a reliability risk.
- **Native transport trust boundary:** Native login uses the protocol's reversible passcode vector (`src/icom-lan/protocol.js:47`); the server compares fixed-size vectors and binds subsequent streams to exact authenticated endpoints (`src/server.js:167`, `src/server.js:265`, `src/server.js:298`). This is not confidentiality/authenticated encryption against a hostile LAN. `docs/operations.md:14` already warns against Internet exposure. This is a documented protocol constraint, not a newly found bypass.
- **Linux plaintext storage is intentional:** TUI/web owner-only storage at `src/app/store.js:36` and `docs/interfaces.md:117` is accurately labeled unencrypted. Desktop uses async native encryption and fails closed when unavailable (`desktop/main.js:7`–`desktop/main.js:29`). Windows ACL behavior and real Keychain/DPAPI were not established by this lane's mocked credential tests. Native installed-app smoke results obtained by the coordinator should be recorded separately.
- **Custom certificate deployment policy:** `src/web/tls.js:28`–`src/web/tls.js:44` checks regular bounded files, rejects world-accessible private keys, validates key/certificate agreement and validity dates. It permits group-readable keys and does not prove that a supplied trusted certificate covers every access hostname. Group-readable service keys can be intentional; no exploit is claimed. Custom-certificate hostname coverage and restrictive service-group membership remain operator validation tasks.
- **Packaged Linux web startup gap:** Current release jobs run extracted headless and Linux TUI smoke tests (`.github/workflows/release.yml:64`–`78`); there is no extracted Linux SEA `--web` startup/login/assets/normal-shutdown smoke. `tests/web-main.test.js:98` mocks SEA asset lookup. The production web server is tested over HTTPS in source mode, but that does not verify the packaged Linux integration or systemd sandbox on Linux.
- **Shutdown deadline:** Both service templates set `TimeoutStopSec=30`; configuration permits 30-second command timeouts and cleanup can require several serial commands. The existing service guide correctly describes the systemd timeout as a last resort. A bounded fixture/systemd test for delayed cleanup near that deadline is absent from this lane. Do not infer a guaranteed 30-second safe stop from normal-path tests.
- **Advisory and supply-chain checks:** The application has no npm runtime dependencies; development dependencies, including Electron/build tooling, are pinned with lockfile integrity entries. No online vulnerability advisory lookup or `npm audit` was run in this lane due the assigned no-network boundary. No absence-of-known-CVE claim is made. The workflow's deliberate unsigned Windows/ad-hoc unnotarized macOS policy is respected, with accurate user-facing documentation; it is not reported as a defect.

## Feature inventory and verification matrix

“Verified” below means the bounded local behavior described in the row, not universal platform or hardware certification.

| Feature / expectation source | Implementation | Existing tests inspected and executed | Added verification | Result |
| --- | --- | --- | --- | --- |
| HTTPS-only production management; explicit loopback-only test escape (`docs/linux-web-service.md`) | `src/web/server.js:60`, `src/web/tls.js` | `web-server`, `web-main` real TLS request, generation/reuse/renewal/invalid-pair tests | Code-path review; no production connection | Verified locally; Linux deployment unverified |
| Login, bootstrap token, credential-change revocation, logout, idle/absolute expiry (`docs/linux-web-service.md`) | `src/web/server.js:111`, `:137`, `:223`; `src/web/main.js:39` | `web-server`, `web-main` | Checked callers and bootstrap transition; token file never copied to report | Verified fixture paths |
| Origin/Host/port/CSRF, body/action/path restrictions | `src/web/server.js:18`, `:33`, `:118`, `:163`, `:199` | `web-server` malformed/traversal/cross-origin/authenticated action tests | Reviewed validation before dispatch | Verified fixture paths |
| Management concurrency and request/session bounds | `src/web/server.js:79`, `:84`, `:144`, `:205`, `:246` | `web-server` rate/session bounds and held Start + Stop/Save | Checked both session and global action sets | Partially verified; no hostile LAN stress |
| Browser sign-out/close leaves service alive (`docs/linux-web-service.md`) | `src/web/main.js:98`, `src/web/server.js:240`; `src/web/bridge.js:104` | `web-server`, `web-main` | Confirmed browser cannot dispatch controller close | Verified server-side fixture paths |
| Desktop IPC/frame isolation and native credential protection (`docs/interfaces.md`) | `desktop/security.js`, `desktop/preload.js`, `desktop/main.js` | `desktop-security` | Inspected main-process action callers, navigation/window/permission denial | Partially verified; unit IPC/encryption mocks |
| Secure settings discovery/import/persistence and redacted diagnostics (`docs/interfaces.md`) | `src/app/store.js`, `src/app/settings.js`, `src/app/controller.js:68`, `:353` | `app-settings`, `config`, `app-controller`, `desktop-security` | No hardcoded live secret found in bounded source scan; only synthetic fixture passwords | Verified tested POSIX file/error paths; crash and Windows ACL gaps above |
| Native auth, source identity, same-IP isolation and bounded preauth/client admission (`docs/operations.md`) | `src/server.js`, `src/icom-lan/protocol.js`, `src/icom-lan/stream.js` | `server` real UDP and in-memory admission tests | Reviewed control/media callers and packet cap | Verified fixture cases; protocol LAN trust limitation |
| One local owner per profile/radio and stale-lock recovery (`docs/interfaces.md`) | `src/app/lock.js`; controller `:83`, `:150`; CLI `:104` | `app-controller` lock and cancellation tests | OS listener mutex inspected; successful exclusion/release | Verified current host; cross-host association not prevented by design |
| Startup cancellation/listener failure/shutdown (`docs/operations.md`) | `src/splitter.js`, `src/cli.js`, `src/app/controller.js` | `operations`, `app-controller`, `web-main` | Additional rejected-stop child-process probe E-1 | Failed legacy headless failure reporting; normal/cancel paths pass |
| systemd/launchd/Task Scheduler install and restart policy (`docs/operations.md`, Linux web guide) | `docs/services/*` | No real service-manager test in this lane | Inspected paths, owner, state dir, hardening, restart/stop policies | Partially verified manifests; service-manager operation unverified |
| Five native standalone targets, three desktop installers, unsigned/ad-hoc policy (`docs/releases.md`) | `release-build`, `desktop-build`, release workflow | `release`, `release-archive` | Deterministic bundler/archive tests and source allowlist review | Partially verified; package documentation omission E-2 |
| Source identity, draft-only publishing, checksums and required assets (`docs/releases.md`) | `release-meta`, `release-publish`, release workflow | `release` version/tag/preview tests | Inspected exact expected asset list, source archive construction, per-runner architecture guards and draft flag | Verified logic; this lane did not publish or fetch assets |
| Runtime OS/architecture floors, Windows/macOS/Linux installed behavior | `docs/releases.md`; release workflow | Local tests on macOS only | Coordinator-provided release/CI provenance below | Partially verified; older OS floors, Linux systemd and Windows physical behavior unverified |

## Verification commands and results

```sh
node --test tests/web-server.test.js tests/web-main.test.js tests/desktop-security.test.js tests/app-controller.test.js tests/operations.test.js tests/server.test.js tests/release.test.js tests/release-archive.test.js
# 80 passed, 0 failed, 0 skipped; Node v26.13.0, local macOS, ~3.65 s
node --test tests/app-settings.test.js tests/config.test.js
# 16 passed, 0 failed, 0 skipped; ~0.46 s
node --check docs/audits/2026-11-11/reproductions/E-headless-failed-release.js
# passed
node_modules/.bin/eslint docs/audits/2026-11-11/reproductions/E-headless-failed-release.js
# passed
node docs/audits/2026-11-11/reproductions/E-headless-failed-release.js
# defect reproduced; exit0 / simulated TX true / no explicit RX warning
```

Tests were inspected rather than treated as sufficient proof. `web-server` includes real HTTP/TLS boundaries and an actual AppController + synthetic native radio interaction. In contrast, `web-main` replaces the service/server in several lifecycle tests; `desktop-security` replaces native encryption and Electron events; several admission tests replace UDP send completion synchronously. Real UDP tests cover complementary cases, but mocks do not establish real Windows/macOS vault behavior or failed-send timing on all operating systems. Existing `operations` SIGTERM coverage only tests successful unkeying, which explains why E-1 is not detected.

The coordinator separately reported GitHub latest release v0.8.1 at `9d9e666`, successful release run `42516452856`, and current-main Verify run `43094197886` with all six OS × Node jobs passing. This lane did not retrieve those external facts. Original-workspace `.release`/`dist` metadata instead identified version 0.1.0 / `0a84c8882bc477149d7e3dc72d8cedf0dce62077`; those stale local files were excluded as current-build proof. After this first pass, the coordinator reported fresh source-`ec801be` macOS Intel standalone CLI, TUI and native-TUI smokes passing. The installed macOS GUI smoke failed on native Keychain availability in its isolated environment; this is an environment-limited result, not demonstrated GUI correctness or an application defect. Deployed-source comparisons remain coordinator-owned evidence.

## Cross-review reconciliation

The coordinator reran E-1 successfully and requested a precise distinction between a generic upstream failure log and an explicit RX-unconfirmed warning. The reproduction now waits for child stdio closure and asserts the RX-specific warning is absent; generic `Radio: failed` is retained in its sanitized evidence. Reviewer C independently confirmed the headless failure-observability defect. The coordinator independently substantiated E-2 in a fresh macOS Intel archive. No earlier reviewer findings were used to create this lane's first-pass assessment. No disputed finding remains in this report; Linux/systemd, other native platforms and physical-radio consequences remain explicitly limited.

## Proposed order

1. Preserve/report failed release in legacy CLI, with child-process failure regressions (small cross-layer result propagation; medium compatibility risk if callers depend on close returning undefined; no protocol change).
2. Add the missing installation artifacts or correct the package-local references (small packaging-only change; low compatibility risk).
3. Add extracted Linux web SEA + systemd fixture smoke and document the stop-timeout envelope (moderate validation effort; no production fault injection).
4. Decide whether interrupted multi-file profile updates require journaling/recovery (optional reliability improvement; avoid widening it into an unnecessary storage rewrite).

No implementation or deployment decision has been made by this review lane.
