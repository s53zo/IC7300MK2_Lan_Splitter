# Reviewer D — interfaces, configuration and statistics UX

Independent first pass at local HEAD `ec801be1af4f0e05e5b156848541a788d7a704b0`, 2026-11-11. The worktree was clean when inspected. This reviewer did not receive another reviewer's findings before the first assessment. No production endpoints, radio, deployed service, credentials, browser smoke output or source changes were used. All extra probes use throwaway files, fixture objects and a fixture subprocess. Introduction history was not traced; provenance below is therefore **uncertain, present at audited HEAD**.

## Assessment

The shared settings/controller design has substantial coverage and the inspected authentication and TX-confirmation callers preserve the intended service boundaries. All 75 targeted tests passed. Two confirmed user-facing/accounting defects are reproducible below. A separate interrupted-save reliability risk and browser restoration gap merit follow-up; neither is evidence of a normal-path authentication bypass or physical-radio failure.

The schema actually has **90 fields**: Radio 4, Network 7, Cache 6, Advanced 6 and Per-command cache 67. `docs/linux-web-service.md:33` still says 89; this is documentation drift, not missing UI functionality.

Coverage bounds: the existing schema test iterates numeric boundary/fraction/invalid cases, and existing tests cover selected host/password/import/boolean and persistence cases. This is not a claim that every possible edge case of every field was executed. Native Windows GUI execution and real desktop safeStorage/keychain behavior remain outside this lane's fixtures.

## Confirmed defects

### D-01 — TUI claims Start/Reconnect succeeded after startup failed

- **Severity:** P3 / low. **Confidence:** high. **Provenance:** uncertain, present at audited HEAD.
- **Files:** `src/app/tui.js:223`, `src/app/tui.js:237`; `src/app/controller.js:169`, `src/app/controller.js:184`, `src/app/controller.js:241`.
- **Trigger:** Save valid settings, then Start while startup fails, for example a listener-bind error or failed initial radio readiness. Reconnect can hit the same outcome.
- **Expected:** A failed startup is reported as failed, with the controller's actionable error.
- **Actual:** `startNow()` catches the failure, records `lastError` and returns a stopped state. TUI `performAction()` treats any returned state without `requiresConfirmation`/`releaseConfirmed:false` as success and displays `Started.` or `Reconnected.`. The dashboard can simultaneously show the stopped state.
- **Impact:** Misleading immediate feedback, especially in first-run setup; the user must infer failure from the dashboard or Diagnostics.
- **Evidence:** `node docs/audits/2026-11-11/reproductions/D-interface-probes.js` uses the real `AppController` and real `TerminalApp` with only the splitter replaced by a deliberately failing fixture. It asserts `running === false`, a nonempty `lastError`, and the incorrect success message for both actions.
- **Smallest fix:** In TUI `performAction()`, derive success from the returned/current state for Start/Reconnect and show `lastError` when startup returned stopped. Alternatively introduce an explicit controller outcome while preserving current GUI/API compatibility.
- **Regression:** Use a real AppController with a rejecting splitter `start()`, then invoke TUI Start and Reconnect. Assert stopped state, an error message and absence of success text. Current TUI lifecycle mocks always make Start succeed or throw, so they miss the controller's returned-failure contract.

### D-02 — Admission history disappears when Stop/Reconnect creates a new service

- **Severity:** P3 / low. **Confidence:** high. **Provenance:** uncertain, present at audited HEAD.
- **Files:** `src/cli.js:70`; `src/app/controller.js:56`, `src/app/controller.js:219`, `src/app/controller.js:279`; expected session-wide statistics described in `docs/interfaces.md` under “Reading the dashboard”.
- **Trigger:** Accumulate `preAuthExpired`, `preAuthEvictions` or `resourceRejects`, then Stop or Reconnect without resetting statistics.
- **Expected:** Historical counters retain the same application measurement window as cache/physical totals, or explicitly expose a separately labeled connection window.
- **Actual:** `totals` accumulates only cache and broker metrics. `status.admission` comes directly from the current server, and stopped state hard-codes zero. Reconnect retains prior cache/physical totals while silently replacing all admission history with zero.
- **Impact:** Diagnostic exports/status lose earlier login-expiry/resource-pressure evidence, making a reconnect appear to have cleared past admission failures. This does not alter client admission itself.
- **Evidence:** The isolated D probe sets historical admission totals to 4/3/2 and cache requests to 9, reconnects, then asserts cache requests remain 9 while admission becomes 0/0/0. `statusSnapshot()` defines these as historical server counters; the implementation has no admission accumulator.
- **Smallest fix:** Accumulate admission counters when retiring a service, combine them with current counters, and clear that accumulator on Reset statistics. Preserve native client counts and queue depth as live gauges.
- **Regression:** Populate each admission counter, Stop/Start and Reconnect, and check retention. Reset between connections and confirm old totals cannot return.

## Reliability risks and gaps, separate from normal-path defects

### D-R1 — Interrupted settings save can leave old settings with a new credential

- **Priority:** P3 reliability risk. **Confidence:** high for the demonstrated failure window; crash frequency and real-world incidence unverified. **Provenance:** uncertain, present at audited HEAD.
- **Files:** `src/app/store.js:61`–`68` (credential write precedes settings rename); caller `src/app/controller.js:117`.
- **Trigger:** Change username and password together, then terminate the process after the new credential has been atomically persisted but before `settings.json` is replaced. Ordinary caught write failures are rolled back correctly; process death cannot execute that rollback.
- **Expected/actual:** A recoverable profile should contain a coherent old or new settings/credential pair. The injected crash reloads the old username and the new password. A running service retains its old in-memory connection until termination, but the next launch can fail authentication.
- **Evidence/limits:** The D probe uses the real `SettingsStore` and `FileCredentialStore`. A credential adapter pauses immediately after the successful file write; the parent kills only that fixture subprocess and reloads the private temporary directory. This widens and deterministically demonstrates a real ordering window; it is not a filesystem power-loss test and does not quantify how likely the narrow production window is.
- **Proposal:** Consider a generation/manifest or recoverable transaction mechanism for the settings/credential pair; preserve platform credential protection and separate-secret requirements. A small README recovery note can precede that larger design decision. Add a subprocess interrupted-save/recovery test. Do not infer that existing rollback tests prove crash atomicity.

### D-R2 — Browser restored from BFCache has no polling recovery path

- **Priority:** P3 browser lifecycle gap. **Confidence:** high for JS state behavior, medium for browser reachability because an actual BFCache restoration was not run in this lane. **Provenance:** uncertain, present at audited HEAD.
- **Files:** `src/web/bridge.js:5`, `src/web/bridge.js:31`, `src/web/bridge.js:73`, `src/web/bridge.js:140`.
- **Trigger:** Browser stores the dashboard in its back/forward cache when navigating away, then restores it via Back.
- **Actual modeled behavior:** `pagehide` permanently sets `stopped=true` and clears polling. There is no `pageshow` handler. A restored JS heap remains frozen at old stats, and subsequent actions return “Please sign in” without checking the still-valid session.
- **Evidence/limits:** The D probe evaluates the actual bridge in a VM, subscribes and polls once, dispatches `pagehide({persisted:true})` and the absent `pageshow`, then verifies no new poll or state request. Current browser tests cover closing but not restoration. The coordinator should confirm reachability in a supported real browser with `pageshow.persisted === true` before promoting this to a confirmed product defect.
- **Smallest fix/test:** Revalidate the session and resume subscriptions/polling on persisted `pageshow`. Browser regression: navigate from dashboard to another origin, go Back, verify a BFCache restore and live counter updates; expired sessions should still return to login.

## Feature verification matrix

“Verified” means bounded source/test or fixture verification, not verification of a shipped executable or physical radio on every OS.

| Feature / expected behavior | Implementation reviewed | Existing tests inspected and additional work | Result / limits |
|---|---|---|---|
| 90 schema fields; radio address/username/password, password import | `src/app/settings.js`, `src/config.js`, GUI `renderFields`, TUI field editor | `app-settings`, `tui`; schema count executed; invalid scalar/range/password/host cases inspected | **Verified** at schema and fixture level; all 90 rendered fields delegated to coordinator browser smoke |
| Listen default 0.0.0.0 in interactive profiles; legacy CLI default 127.0.0.1 | `settings.js:15`, `config.js:24` | Defaults and CLI docs compared | **Verified** intentional interface distinction |
| Six distinct native ports; relay-loop detection, IPv4 only | `config.js:25`, `config.js:37`–`50` | Config call path and existing settings tests; no real listener/radio used | **Partially verified**; physical/native transport lane owns network behavior |
| Global/family/per-command cache defaults, 0 opt-out and blank inheritance | `settings.js`, `config.js`, `read-cache.js` callers; renderer/TUI editors | `app-settings`, `tui`, `telemetry-ui` assertions | **Verified** configuration/UI contract; cache correctness belongs to lane B |
| Telemetry toggle, fixed targets, stale/RX-zero labels | `settings.js`, `renderer.js:184`–`216`, `tui.js:86`–`104` | `telemetry-ui`, reset tests; traced `telemetrySnapshot()` | **Verified** fixture labels; RF/timing targets unverified here |
| Client/preauth memory budgets and all timeout limits | `settings.js`, `config.js` | Existing min/max/fraction/invalid validation loop covers every numeric schema field | **Verified** input validation; capacity semantics owned by transport/security lanes |
| Save versus active settings, pending banner, defaults, Save & connect | `controller.js`, `renderer.js:237`–`307`, `tui.js` | `app-controller`, `app-settings`, `tui`; read actual renderer callers | **Verified** normal lifecycle; interrupted persistence risk D-R1 |
| Credentials separately persisted, private files, desktop encryption and refusal to fall back | `store.js`, `desktop/main.js:7`–`29` | `app-settings`, `desktop-security`; failure rollback and secret-redaction assertions inspected | **Partially verified**; OS safeStorage is mocked in this lane, no actual Windows/Keychain unlock claim |
| Config discovery, explicit directory and duplicate app/radio ownership | `store.js:6`–`10`, `cli.js:84`–`104`, `web/main.js:53`, `controller.js` | `app-controller`, `web-main`, source CLI paths | **Verified** source/fixture paths; no installed Linux binary or production service touched |
| Start/Stop/Reconnect and TX confirmation (owner, observation, pending and queued initiators) | `controller.js:132`–`256`, renderer/TUI callers | `app-controller`, `app-native`, `tui`, `web-server`; real synthetic native session tests passed | **Partially verified**; controller/fixture gate passes; TUI startup result defect D-01; no physical TX |
| Unreachable radio keeps management available and Stop/Save usable | `web/main.js:76`–`105`, `web/server.js:249`–`264`, controller operations/saves | `web-main`, `web-server`, pending-start tests | **Verified** fixtures; full service deployment unverified here |
| Browser close, logout do not own radio/service lifetime | `bridge.js:66`, `bridge.js:104`–`110`, `bridge.js:140`, web actions | `web-frontend`, `web-server`, `web-main` | **Verified** close/logout fixtures; restore gap D-R2 |
| Bootstrap/login, saved-credential changes and session revocation | `web/main.js:25`–`49`, `web/main.js:85`–`95`, `web/server.js` | `web-main`, `web-server`, `web-frontend`; dynamic credential provider traced | **Verified** isolated flows; no live credentials accessed |
| HTTPS required, automatic/custom TLS, same-origin/CSRF, allowlisted assets/actions/body limits | `web/server.js`, `web/tls.js`, `web/assets.js`, desktop CSP/IPC | 75-test subset includes actual loopback TLS, renew/reuse, bad key/cert, Host/Origin/CSRF/traversal/restricted IPC cases | **Verified** isolated HTTPS/security behavior; no security-review claim beyond inspected paths |
| Idle/absolute session expiry, throttles and bounded sessions | `web/server.js:106`–`153`, `web/server.js:230`–`254` | `web-server` clock-driven limits and `web-frontend` expired-session redirects | **Verified** mocked clock; browser poll keeps session active by design |
| Password imports local to browser and desktop picker; server paths rejected | `bridge.js:43`–`62`, `desktop/main.js:107`, `web/server.js:177`, `settings.js` | `app-settings`, `web-server`, `web-frontend` size/import path assertions | **Verified** fixtures; no platform file-picker UX run here |
| Diagnostic export, secret redaction, sanitized client labels/control sequences | `controller.js:68`–`75`, `controller.js:353`, `desktop/security.js:25`, renderer export, TUI export | `app-controller`, `desktop-security`, `tui`, `web-server`; inspected all three export routes | **Verified** fixture secrets; exports contain operational info intentionally |
| Live clients, authenticated counts, TX owner and stream readiness | `controller.js:288`, `cli.js:53`, renderer clients, TUI clients | `app-native`, `web-server` synthetic sharing; source count/row mapping read | **Partially verified**; no real third-party client UX on three OSes |
| Rates, hit denominator, separate ping/command/queue labels and 15-minute bounds | `controller.js:302`–`349`, renderer/TUI dashboards | `app-controller` same-ms/full-interval test, native ping snapshot path, telemetry UI tests | **Verified** fixtures; TUI “Client requests” rate label could more precisely say cache-eligible requests (optional wording) |
| Historical cache/metrics across Stop/Reconnect; current gauges remain live | `controller.js:13`–`43`, `controller.js:175`, `controller.js:219`, `controller.js:279` | `app-controller` accumulation tests plus D probe | **Failed** for admission counters (D-02); telemetry explicitly labels current connection in GUI |
| Reset zeroes counters/rates/history without touching connections/cache/TX/schedules | `controller.js:258`–`277`, broker reset caller, renderer confirmation | `statistics-reset`, `app-controller`, `web-server`; tests include queue/in-flight/telemetry preservation | **Verified** isolated reset coverage; no production reset; TUI exposes no reset action (not documented as one) |
| Windows/macOS GUI, Linux TUI and Linux-only web platform gating | desktop main/preload/security/index, `cli.js`, `web/main.js` | `desktop-security`, `tui`, `web-main` platform gating and source inspection | **Partially verified**; Linux simulated for web startup tests on this Mac host; no Windows execution or shipped binary verification in this lane |

## Reproduction and verification record

Run from repository root:

```sh
node --test tests/app-settings.test.js tests/app-controller.test.js tests/app-native.test.js tests/tui.test.js tests/desktop-security.test.js tests/web-main.test.js tests/web-server.test.js tests/web-frontend.test.js tests/telemetry-ui.test.js tests/statistics-reset.test.js
node docs/audits/2026-11-11/reproductions/D-interface-probes.js
node --check docs/audits/2026-11-11/reproductions/D-interface-probes.js
```

- Targeted suite: **75 pass, 0 fail, 0 skipped**, approximately 1.92 seconds on the current Mac runner.
- Extra probe: exits 0 after asserting the two defects, the interrupted-save state and modeled browser restoration gap. Its output is sanitized and contains no raw credentials.
- Probes restore/delete all their temporary state. SIGKILL targets only the spawned temporary persistence fixture.
- No shared browser smoke was run. No source, tests, dependencies, service configuration or deployment were changed. Coordinator owns full-suite/lint/build/native browser verification and cross-review.

## Recommended order

1. Fix D-01's result handling and D-02's admission accumulation with focused regressions (small, low compatibility risk).
2. Confirm real-browser BFCache restoration, then fix D-R2 if reachable (small lifecycle change).
3. Decide the desired interrupted-save recovery guarantee and design/test D-R1 accordingly (moderate persistence/credential compatibility risk). This risk should not be silently conflated with the already-tested caught-error rollback.
4. Update the field count and optionally clarify the TUI rate label. These do not block normal use.
