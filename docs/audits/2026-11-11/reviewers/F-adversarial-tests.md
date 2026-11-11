# Reviewer F — adversarial verification and test quality

Audit date: 2026-11-11. Source: `ec801be1af4f0e05e5b156848541a788d7a704b0`.
Environment: macOS (`darwin`), Node `v26.13.0`. Initial worktree was clean.

This lane inspected implementations and callers, formed an independent first
pass, and sent it to the coordinator before reading other reviewers' probes.
Later cross-review is explicitly separated below. No production host, service,
radio, real credential, or physical TX was used. Only this report and `F-*.js`
audit reproductions were written; no product code or existing tests changed.

## Independent first-pass assessment

The test suite has substantial real UDP coverage as well as useful deterministic
broker tests. It independently encodes a radio and a downstream client rather
than using only the product encoder. Passing tests still leave lifecycle
boundaries untested. This lane confirmed one unexpected defect: historical
transport counters disappear after automatic recovery. A second fault probe
confirmed the already documented delayed-audio limitation, which is a residual
risk rather than an undisclosed defect or recent regression.

### F-01 — automatic recovery erases transport history

- **Classification:** confirmed defect; medium severity; high confidence.
- **Feature:** statistics across reconnects and failure diagnosis.
- **Expectation:** `docs/interfaces.md:173-177` says statistics cover the current
  application session including reconnects; the task also explicitly requires
  accumulation across reconnects until reset.
- **Implementation:** `src/broker.js:156-157` reads only current stream counters;
  `src/icom-lan/session.js:62-72` replaces all three stream objects in `begin()`;
  `src/icom-lan/stream.js:24` initializes every new stream's counters to zero.
  `src/app/controller.js:154-157` handles automatic recovery by sampling the same
  service; its stop/start accumulation path at `219-221` is not entered.
- **Trigger:** establish one loopback native client, deliver and duplicate a
  valid RX audio datagram, let the synthetic radio release its upstream media,
  wait for automatic recovery, then deliver another audio datagram.
- **Expected:** duplicate history remains `1`, connection recovers, future
  counters continue accumulating. Explicit reset should be the boundary that
  zeroes this history.
- **Actual:** duplicate count changes `1 → 0` while broker physical dispatches
  accumulate `5 → 10`; both audio packets reach the existing downstream client.
  No statistics reset occurred.
- **Impact:** diagnostics after the failure lose the transport history most
  relevant to investigating it. Loss, stale, malformed, and replay counters use
  the same replacement path; the executable reproduction directly establishes
  the duplicate counter only. This does not corrupt audio or TX ownership.
- **Proof:** run
  `node --test docs/audits/2026-11-11/reproductions/F-transport-reconnect.js`.
  It deliberately asserts the desired behavior and exits **1** on current
  source, printing only
  `{"beforeDuplicates":1,"afterDuplicates":0,"beforePhysical":5,"afterPhysical":10,"recoveredAudioPackets":2}`.
- **Provenance:** pre-existing. `git blame` attributes the current snapshot path
  to `5dae6cf`; stream replacement and zero initialization were already present
  in `babc6dc`. It is not attributed to `ec801be`.
- **Smallest practical fix:** retain retired-stream historical totals per role
  in the owning session or broker and add current counters when snapshotting.
  Clear both retained and current totals on explicit reset; guard finalization
  so an association is folded into history once. Keep sequence/replay state and
  live gauges out of this accumulation. Labeling all transport fields as
  association-only would be a smaller implementation change but would weaken
  the stated session-wide statistics contract.
- **Regression:** duplicate/loss/replay events before two automatic recoveries
  must accumulate once; reset between recoveries must produce zero without
  restoring old totals, closing clients, or disturbing PCM/TX state.

### F-R1 — unseen old audio can enter a later same-association lease

- **Classification:** confirmed documented limitation / residual reliability
  risk; medium impact; high confidence. Do not count as a newly found defect.
- **Contract boundary:** `docs/architecture.md:111-116` and
  `docs/validation.md:115-118` explicitly describe this ambiguity: native packets
  have no TX epoch, so a packet never previously seen can appear current later.
- **Implementation:** `src/server.js:55-66` advances the watermark through
  observed and buffered sequence values only. `src/broker.js:625-632` forwards
  any valid PCM from the current owner when the current lease permits audio.
- **Reproduction:** withhold one valid audio UDP datagram during a legitimate
  PTT lease; finish cleanup; call sender `playback.setKeyed(false)` to invalidate
  its replay history; reacquire PTT on the same native association; deliver the
  already-in-flight datagram. Its PCM reaches the synthetic radio in the new
  lease. This is a delayed network packet, not queued product playback.
- **Proof:**
  `node --test docs/audits/2026-11-11/reproductions/F-delayed-audio-lease.js`
  exits **1** because it asserts the stronger desired guarantee. Its sanitized
  result includes `oldPcmDeliveredInNewLease:true`.
- **Impact bounds:** a prior voice/modem fragment can enter a later, legitimately
  active transmission by that authenticated client. The datagram does **not**
  acquire ownership or key the radio itself; this is not arbitrary unauthenticated
  audio injection. Different-owner audio remains rejected.
- **Provenance:** pre-existing and documented in `babc6dc`; not newly introduced.
- **Practical options:** preserve the limitation explicitly, or require a fresh
  media association/identity at lease boundaries for a stronger isolation mode.
  The latter requires native-client interoperability work. Clearing reorder or
  sender replay maps again cannot identify an unseen packet already in flight.
- **Regression/validation:** retain this as a known-limit probe alongside the
  existing seen-packet retirement tests. If stronger isolation is introduced,
  test delayed unseen packets across repeat leases and sequence wrap, with
  unchanged client compatibility and normal audio startup latency measured.

## Feature and verification matrix

Results below apply to the specified isolated tests, not a physical MK2 or all
operating systems. Existing tests were read as assertions, not accepted as proof
from names alone.

| Feature and expected behavior | Implementation inspected | Existing evidence inspected and executed | Added verification / result | Remaining boundary |
| --- | --- | --- | --- | --- |
| One upstream association, multiple same-IP/controller clients; private replies | `splitter.js`, `server.js`, `broker.js` | `integration.test.js`, `server.test.js` | **Verified synthetically:** single association and separate reply routes | Independent full RS-BA1/wfview applications not run by this lane |
| Sequential control dispatch; writes cannot cross read/cache barriers | `broker.js:360-489`, `read-cache.js` | `broker.test.js`, `cache-broker.test.js`, `cache-integration.test.js` | **Verified synthetically** for covered read/write traces and shared controllers | Unknown CI-V variants rely on conservative mutation classification |
| PTT/CW/VOX/tuner/voice ownership and partial-trigger stops | `broker.js:44-65,570-607,653-756` | `broker.test.js`, `safety-poll.test.js` | **Partially verified:** compound triggers and late start ACK protections pass | Modeled ACKs do not establish real firmware cleanup semantics or RF state |
| Lease-ending stop ACK after confirmed RX; immediate read/restore of 0084 | `broker.js:613-622,653-695` | `broker.test.js:482-587` | **Verified against transport double** including cleanup failure and reset | No new real-radio or full native-app 0084 sequence performed |
| Disconnect/heartbeat recovery discards old work | `broker.js:266-327,635-651`, session lifecycle | `integration.test.js`, `broker.test.js` | **Verified synthetically** for timeout, heartbeat, upstream release and media generation cases | Cross-review exposes unrelated reads between cleanup steps; see below |
| Cache eligibility, exact TTL, zero opt-outs and overrides | `read-cache.js`, `broker.js:162-243` | `cache-broker.test.js`, `cache-integration.test.js` | **Verified** for documented supported queries and boundaries in these suites | Read allowlist correctness against every firmware command remains external protocol validation |
| Shared telemetry, fresh RX zeros, TX-only meters, no catch-up | `telemetry.js`, broker polling | `telemetry.test.js`, `telemetry-audit.test.js`, `safety-poll.test.js` | **Verified with deterministic clocks** for 100/500 ms scheduling and bounds | Loaded event-loop/network timing and physical sample age not established |
| Audio/scope fanout, loss repair, duplicate suppression and wrap | `server.js`, `icom-lan/stream.js`, `protocol.js` | `integration.test.js`, `protocol.test.js`, `server.test.js` | **Verified on loopback UDP** for covered packet traces | Perceptual audio quality, WAN jitter and RF modulation not measured |
| Obsolete audio/keying retirement | `server.js:55-66,347-367`, `broker.js:253-264` | Server seen-packet retirement and wrap tests; broker media generation cases | **Partially verified:** seen work retires; F-R1 independently demonstrates unseen-audio limit | No epoch exists in the unchanged native wire format |
| Admission, queue, replay/reorder and pending-send bounds | `server.js:81-113,139-184,250-328`, `stream.js`, broker limits | `server.test.js:219-227,340-442`, broker flood tests | **Verified for bounded fixtures:** caps, invalid configuration and 18 simultaneous default logins pass | Sustained hostile ingress, slow callbacks, shared-socket errors and long soak remain |
| Statistics reset retains cache, pending work, telemetry and TX | `broker.js:121-139`, `telemetry.js:18-21`, controller reset | `statistics-reset.test.js`, broker deferred-stop reset test | **Verified against controlled fixtures:** old logical admissions retire without negative totals, new physical work counts | Needs combined real UDP reset/reconnect/TX failure stress, rather than only sequential cases |
| Historical statistics across automatic recovery | Stream creation, `metricsSnapshot()`, controller sampling | Existing metrics/reset tests do not replace actual upstream streams | **Failed:** F-01 real UDP counter conservation probe | Merge with lane B's duplicate finding in consolidated report |
| HTTPS/login/CSRF/session expiry/config actions | `web/server.js`, bridge, controller callers | `web-server.test.js`, including real TLS and actual synthetic service | **Verified within tested APIs:** auth, body limits, save/reconnect, start/stop and service persistence | Browser rendering/navigation and platform startup are separate lanes |
| Browser close/sign-out leaves radio service alive | `web/bridge.js:104-110,140`, web/server closure | Web-server closure test, browser test source | **Partially verified:** HTTP close does not own radio controller; browser handler sends no close action | Actual Linux browser/service deployment not used by this lane |
| CLI shutdown reports receive failure | `cli.js:109-125`, `splitter.js:64-79`, broker close | Existing `operations.test.js:58-97` tests successful release only | **Failed in later cross-review:** E probe exits 0 without actionable warning on rejected stop | Native Windows forced termination is a different boundary, not tested here |

## Test quality and coverage gaps

These are coverage gaps or limits, not additional confirmed product defects.

1. **Microtask broker doubles conceal transport lifecycle.**
   `tests/broker.test.js:10-35` and `tests/telemetry.test.js:10-22` answer through
   `queueMicrotask`, generally return ACK for writes, and use no-op/record-only
   replay invalidation. These are good deterministic state-machine tests, but do
   not replace transport callbacks, retransmit gaps, socket failure, or delayed
   packets crossing repeated leases. `tests/statistics-reset.test.js:11-27`
   likewise keeps the same mock stream object through reset; it cannot expose
   F-01's automatic stream replacement.

2. **The tests for old media exercise an observed watermark.**
   `tests/server.test.js:281-323` deliberately deliver a later packet into reorder
   before retirement. They establish rejection of a late gap-fill below that
   watermark. They do not establish the stronger guarantee that every old
   datagram is rejected; F-R1 makes the already documented boundary executable.

3. **Happy-path cleanup lacks a contending-reader timeout matrix.**
   Broker release tests usually either finish cleanup automatically, suspend all
   replies, or inject immediate failure. They do not keep an unrelated queued
   read between each successful cleanup step and then fail that read. This gap
   allowed the cross-reviewed A finding. Add cases after PTT-off, mode read,
   keyer stop and each obligation, preserving FIFO handling for the transaction
   already in flight while reserving subsequent cleanup work.

4. **Successful SIGTERM is insufficient for failed cleanup reporting.**
   `tests/operations.test.js:58-97` asserts exit 0, RX, and a generic stopping
   message after successful fixture cleanup. Add rejected stop, mode read NG,
   RX-confirmation still TX and timeout variants, asserting non-success reporting
   without claiming that process exit proves the radio has stopped.

5. **Capacity tests establish bounds in selected conditions.**
   `tests/server.test.js:219-227` checks replay size and pending-byte caps while
   sending synchronously; preauth fixtures at `340-360` normally invoke UDP send
   completion immediately. The explicit delayed authentication rejection test
   at `414-429` is a useful exception. Add held/error completion and several
   active-client scenarios, then verify peers, timers, reservations and callbacks
   are retired once. Test direct upstream send queue behavior separately from
   the bounded downstream `Peer.raw()` implementation.

6. **Timing schedule correctness is not delivery timing.**
   Fake-clock telemetry tests manually invoke ticks and complete model replies;
   they prove due-time and no-catch-up logic. A bounded real UDP test combining
   telemetry, admission pressure, media fanout, TX stop and statistics reset
   should measure sample ages and stop latency. Physical radio timing and audio
   quality remain outside the evidence here.

7. **Interface test layers should remain distinct.**
   Web server tests include a real AppController plus actual synthetic UDP radio
   (`tests/web-server.test.js:184-220`), which is stronger than controller-only
   mocks. Browser unit tests use VM/document doubles, however, and do not prove
   rendering, focus, bfcache/navigation restoration, or actual Linux service
   lifetime. Those need browser/service checks; other audit lanes own them.

## Later cross-review of other lanes

The following was performed only after the independent first-pass findings were
sent to the coordinator. It is corroboration, not independent discovery.

### A — unrelated read can interrupt multi-step TX cleanup

Ran `node docs/audits/2026-11-11/reproductions/A-release-read-interleave.js`.
It exits **0** because it asserts the current defective behavior. The trace was
client `03` → release `1c0000` → unrelated client `04`, followed by read timeout;
release returned false and VOX-disable `164600` was never sent.

The source explains the result: `broker.receive()` resolves an internal promise
at `568`, then calls `pump()` at `609` before the `release()` continuation can
enqueue its next safety command at `672`. Retained unrelated reads are permitted
during release. If one does not answer, transaction timeout resets the session
before remaining cleanup obligations execute. Medium severity and high
confidence are appropriate. The finding is cleanup ordering/availability, not
proof of RF transmission: PTT-off itself succeeded in this trace, while modeled
VOX remained enabled. The timeout/failure cannot establish actual RF state.

Recommended regression: inject failure only into the unrelated read, verify that
it cannot prevent remaining safety commands, and verify no stale ACK follows a
failed release. Reserving cleanup dispatch across its await boundaries is the
smallest relevant fix; do not preempt the transaction already in flight.

### E — headless failed release exits successfully without actionable RX warning

Ran `node docs/audits/2026-11-11/reproductions/E-headless-failed-release.js`.
It exits **0** because it asserts the current defective behavior. An actual
headless child CLI used isolated UDP fixtures and SIGTERM. Result:
`rejectedStops:1`, simulated radio still TX, child `exitCode:0`, empty stderr,
and `explicitReceiveUnconfirmedWarning:false`. Generic `Radio: failed` appeared;
there was no explicit receive-state failure instruction.

`src/broker.js:759-765` awaits but discards `release()`'s false outcome;
`src/splitter.js:73-77` therefore closes normally; `src/cli.js:110-115` reports the
attempt and releases the lock without inspecting the result. By comparison,
`src/app/controller.js:198-203,227-232` explicitly reports unconfirmed receive.
Medium severity and high confidence are appropriate for shutdown reporting.
The radio's refusal is an injected external failure; the product defect is
presenting it as successful shutdown without the actionable warning.

Recommended regression/fix: propagate release confirmation through close,
preserve resource cleanup, and assert a non-success exit/status plus an explicit
instruction to check the radio when RX was not confirmed. Do not promise that
exit status itself guarantees physical unkeying. This POSIX result is not
Windows console or forced-service-stop validation.

## Commands and evidence summary

- Existing targeted suite: `node --test tests/broker.test.js tests/cache-broker.test.js tests/cache-integration.test.js tests/broker-metrics.test.js tests/statistics-reset.test.js tests/telemetry.test.js tests/telemetry-audit.test.js tests/safety-poll.test.js tests/protocol.test.js tests/integration.test.js tests/server.test.js tests/web-server.test.js` — **157 passed, 0 failed, 0 skipped**, 1.78 seconds in this run.
- `F-transport-reconnect.js` — expected **exit 1** on current source; desired
  reconnect counter invariant fails, with media recovery established first.
- `F-delayed-audio-lease.js` — expected **exit 1** on current source; intentionally
  demonstrates a stronger guarantee than the documented native protocol offers.
- A release/read interleave and E failed-release shutdown probes — **exit 0**,
  because their assertions reproduce current defective behavior; results above.
- No lint, build, browser, hosted CI or platform result from another lane is
  claimed as this lane's independent execution. The coordinator owns whole-audit
  validation and platform/release reconciliation.

## Recommended order and remaining risks

Prioritize the cross-reviewed cleanup dispatch ordering and truthful headless
failure reporting, then retain transport history across automatic recovery.
The transport accounting change should be narrow but needs reset and multiple
recovery tests to avoid double accumulation. Stronger unseen-audio lease
isolation is a separate compatibility decision, not a quick watermark edit.

Physical CW/VOX/tuner/voice-memory behavior, RF unkeying, audible media quality,
firmware-specific replies, sustained hostile-load resistance, long soak, and
non-macOS native execution remain unverified by this lane. Existing recorded
hardware results and other reviewers' platform evidence are not substituted for
those missing tests.
