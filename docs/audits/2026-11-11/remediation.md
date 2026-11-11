# Audit remediation and independent verification

This follow-up implements the findings from the ec801be audit. The original reports and counterexample probes remain unchanged. The owner's subsequent instruction authorizes committing, pushing and Pi deployment; publishing a release and physical TX testing are not part of this change.

## Finding-by-finding completion

| Finding | Implemented behavior / changed files | Regression evidence | Review |
| --- | --- | --- | --- |
| AUD-01 | broker.js reserves dispatch for release/startup across asynchronous gaps; unrelated queued reads resume after cleanup | cleanup-reservation: all PTT/keyer/voice/tuner/VOX/RX-confirm steps, competing readers, existing partial-trigger/deferred-ACK cases | Independent core review; no unresolved finding |
| AUD-02 | broker.close and Splitter.close return releaseConfirmed; CLI reports unconfirmed RX and exits1; controller honors explicit results. Loss retains TX uncertainty until fresh confirmed startup/release | operations-shutdown real child NG/timeout/success; actual unowned-TX disconnect; controller confirmation; fresh startup clears uncertainty | Core reviewer found loss-erasure gap; fixed and independently rechecked |
| AUD-03 | upstream audio has byte/packet bounds plus separate heartbeat allowance, safe callback accounting and observable drops/errors; no application media queue | transport-reliability held/error/double/late callbacks, cap/replay/reset/close; overload-release real UDP: held2/dropped48 while OFF confirmsRX, no backlog drain | Independent core fault injection and source review |
| AUD-04 | upstream audio only detects sustained advancing unusable sequence traffic with live pings and renews the association; downstream retirement/watermarks untouched | half-space progression triggers fresh IDs/media recovery; normal wrap, inactivity, intermittent gaps and peers do not cause false recovery | Independent core source/tests review |
| AUD-05 | session cumulatively retires upstream stream counters; snapshot sums active plus retired, with current-only outstanding gauges; reset clears both banks and fences old completion counts | transport-reliability repeated real UDP reconnects, reset/recovery boundaries; controller gauge aggregation; F reconnect invariant now passes | Independent core review |
| AUD-06 | controller accumulates admission events on stop and failed startup, resets cumulative/current together, preserves live client gauges | app-controller repeated reconnect/Stop/Start and reset; retained transport gauges zero when stopped | Independent core and interfaces review |
| AUD-07 | TUI success/Connected requires actual transport AND broker readiness, reports resolved failure state truthfully | tui failed Start/Reconnect, connecting, transport-up/broker-not-ready, normal successful actions | Interfaces reviewer found partial-ready gap; fixed and rechecked |
| AUD-08 | read-cache restricts1656 to00/01 and corrects positive oracle | legal/bad enum tests and audit-cache-regressions second client fresh read after invalid reply | Independent core review |
| AUD-09 | telemetry records a bounded reason exactly once when an eligible client actually falls back; invalidated metadata contains no values and is bounded by query keys | cold/stale/exact expiry, epoch/generation, disabled/internal exclusion, reset cohort suppression | Independent core review |
| AUD-10 | shared eight-file install manifest stages guides/service templates with preserved paths in standalone/desktop; templates explain executable vs source; docs distinguish HTTPS management and local answers from netRF traffic | deterministic extracted tar.gz/ZIP relative-link/header checks; builder manifest tests; launchd plutil | Independent interfaces/package review |

## Additional risk dispositions

- **Helper generations:** all cleanup/startup internal dispatches carry the captured expected broker generation. Nested keyer/initiator calls cannot admit work into a new generation. Tests cover loss immediately after an awaited reply; startup cannot become ready from stale work.
- **Interrupted settings/credentials:** SettingsStore serializes operations, writes an adapter-protected recovery credential plus secret-free journal, and uses atomic settings generation as commit marker. Recovery restores the old pair before commit or retains the new pair after commit; repeated interrupted recovery is safe. Legacy version1 profiles migrate on the next save. Desktop backup uses the same OS-backed encryption adapter; Linux backup stays owner-only. SIGKILL tests cover old/current/first-save and interrupted rollback through file/encrypted desktop fixtures. This is process-crash recovery, not a power-loss/fsync guarantee; native Keychain/DPAPI availability is not proven by the encryption fixture.
- **BFCache:** actual Chrome157 with unchanged production no-store headers does not restore this page (main-resource and API no-store reasons). A controlled test-only cache-header relaxation produces actual persisted same-heap restoration and proves session revalidation, fresh CSRF, polling, expired-session redirection and service independence. VM regressions cover stale lifecycle responses and transient restore-session failure followed by successful retry. Production cache headers are unchanged. Other browsers' eligibility remains unverified; no claim is made that the stock-header page currently enters BFCache in Chrome.
- **Unseen old UDP audio:** the owner explicitly chose unchanged-client compatibility and retention of this documented native-wire limitation. No forced association rotation or incompatible lease extension was introduced. Existing observed replay retirement remains, and application-owned upstream backlog was eliminated/bounded; already-submitted OS packets cannot be recalled. Absolute exclusion of an unseen delayed datagram in a later legitimate same-association TX lease is not claimed. A future strict policy would require media-session rotation or client protocol cooperation; timing quarantine cannot provide that guarantee.

## Independent reviews

Two reviewers who did not implement the changes inspected current source/callers and ran isolated probes:

- Core: 98 targeted tests plus real UDP audio-overload/release injection. One medium gap (lost unowned TX uncertainty) was fixed and rechecked; no unresolved core findings. Reviewed core diff SHA256 a1cfbf990d640e1c31f72bd9f8ff99a8ddc75d2d1a93141b77f784f32c3a6bb2.
- Interfaces/persistence/packages: 100 targeted tests, SIGKILL recovery, admission/reset, auth lifecycle and archive closure. Two low gaps (failed restored auth permanently stopping retry; transport-only TUI readiness) were fixed and rechecked. Final stale-lastState lifecycle guard also independently reviewed, with10web tests passing. Earlier scoped source diff SHA25635a36e59445b5ccdaf213af2a8cfdfdc459f80941be002f761ab22dc2bc7230c; later one-line guard was checked separately.

Counts overlap; do not add them to the full-suite total. Historical audit probes assert original counterexamples and may fail now that a finding is fixed. Desired-behavior regressions live in tests/ and are the acceptance gates.

## Validation and delivery record

- Full current local suite:354passed,0failed; lint and syntax/static checks passed. Node26.13.0, macOS Intel.
- HTTPS browser smoke passed with90settings, two real native fixture clients, one synthetic upstream, exact PCM/scope, reset confirmation, persistence and lifecycle behavior.
- Isolated128client and active-telemetry/uncached-control/media loads passed; these are short loopback workloads, not Pi capacity or audible-quality guarantees.
- Browser BFCache evidence: [remediation-bfcache.json](remediation-bfcache.json). Production-header and controlled-fixture outcomes are deliberately separate.
- Fresh package/platform results and deployed commit are recorded in the delivery evidence after those gates run. Do not infer native Windows/ARM, interactive OS-vault, physicalradio or RF verification from local fixtures.
- Pi access uses a per-connection SSH IPQoS=none option after default-QoS banner timeouts. This does not change host configuration. Deployment preserves saved configuration/credentials/TLS and boot-enabled service behavior, and is gated on RX; no physical TX test is authorized.
