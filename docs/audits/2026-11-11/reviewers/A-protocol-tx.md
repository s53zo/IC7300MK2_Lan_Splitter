# Reviewer A — native LAN protocol, routing and TX safety

Review date: 2026-11-11. Source baseline: `ec801be1af4f0e05e5b156848541a788d7a704b0` (`0.8.1`). The worktree was initially clean. This review was independent of other reviewers' conclusions; the first candidate findings were sent to the coordinator before cross-review. No radio, deployment, production endpoint or external account was accessed. Only this report and isolated reproduction scripts were added.

## Assessment

The modeled native association, private reply routing, TX ownership and deferred stop-ACK paths have substantial, meaningful fixture coverage. The latest lease-ending stop-ACK behavior passes its targeted tests, including immediate `1A 05 00 84` read/restoration, failed cleanup, disconnect, media replacement, session replacement and reset accounting. One pre-existing, reproducible scheduling defect allows unrelated queued client reads to interrupt multi-command TX cleanup. A separate fault-boundary probe demonstrates missing helper-local generation guards, but current reconnect cancellation prevents the demonstrated stale queued command from being sent; this is reported as a risk/coverage gap, not an established unsafe transmission.

## Confirmed defect A-1

**Medium severity (P2); high confidence. Unrelated queued reads can interrupt TX cleanup before every initiator is stopped.**

- Feature: owner disconnect, explicit release, and shutdown cleanup under concurrent client reads.
- References: `src/broker.js:351` permits reads while releasing; `src/broker.js:566` resolves internal requests; `src/broker.js:609` immediately pumps more queued work; `src/broker.js:653` starts release; `src/broker.js:664` retains other clients' reads; `src/broker.js:670` and `src/broker.js:712` enqueue cleanup one awaited command at a time.
- Expected: after consuming an already in-flight transaction, cleanup bypasses nonessential work until the keyer and remembered initiators have been stopped and a fresh receive state has been confirmed. This is the behavior described in `docs/architecture.md:83` and the intent of priority internal dispatches.
- Actual: after each safety-command reply, `receive()` resolves its promise and calls `pump()` synchronously. The next cleanup step is only queued when its async continuation runs. A retained client read therefore starts first and occupies the single upstream CI-V transaction slot. A slow/unanswered read can reset the association before remaining initiator stop commands execute.
- Reproduction: run `node docs/audits/2026-11-11/reproductions/A-release-read-interleave.js`. Establish a VOX owner; hold one other-client frequency read in flight; queue that reader's mode read; disconnect the owner; complete the in-flight read and successfully ACK cleanup PTT-off; leave the reader's mode read unanswered. The script uses the real broker, controlled radio replies, no sockets and no credentials.
- Observed trace: client `03` → internal release `1c0000` → client `04` → request timeout/reset. `releasePromise` resolves `false`; VOX-disable `164600` is never dispatched. The 40 ms fixture timeout accelerates the default 2000 ms failure path. Even when every client read succeeds, the same scheduling order inserts additional transactions between cleanup steps.
- User impact: preventable release failure/recovery delay under concurrent polling; remembered automatic initiators can remain enabled until a subsequent association cleans them up. This probe does not establish physical RF behavior. There is no false successful deferred stop ACK in this failure case.
- Origin: pre-existing. `git blame` attributes the synchronous final `pump()` to the initial tracked baseline `babc6dc`; the async cleanup chain/priority helpers existed before `ec801be`.
- Smallest practical fix: reserve dispatch for the active safety-cleanup sequence while `releasing` is true, retaining ordinary reads for after confirmation. A cleanup transaction/state machine is an alternative if required to make helper sequencing explicit. Avoid merely adding another priority insertion; the current issue occurs before that insertion runs.
- Required regression: retain other clients' queued reads, introduce realistic delayed replies and verify no non-cleanup dispatch occurs between first cleanup dispatch and fresh RX confirmation. Cover PTT, CW, VOX, voice and tuner obligations, plus successful and failing cleanup. Verify retained reads resume afterward without ordering loss and deferred ACK/accounting remains correct.

The coordinator independently reproduced the same trace and accepted this finding as medium severity/pre-existing.

## Suspected risks and coverage gaps

**A-R1 — Helper-local generation guards are incomplete. Confidence: high in the guard gap; low in additional user-visible harm beyond current cancellation.**

`release()` checks generation after `stopKeyer()` and `stopInitiators()`, but neither helper checks it inside its own awaits (`src/broker.js:715`, `src/broker.js:720`). Startup also only checks its captured generation at the end of the multi-command chain (`src/broker.js:304`, `src/broker.js:317`). `internal()` stamps whatever generation exists at admission (`src/broker.js:336`).

Run `node docs/audits/2026-11-11/reproductions/A-generation-boundary.js`. The real broker completes a CW-mode reply, then the fixture injects a synchronous association failure before the promise continuation. The old `stopKeyer()` continuation admits `17ff` with generation 2 although the release began in generation 1. It remains queued while disconnected. Reconnect `synchronize()` currently calls `lost()` and cancels this queue before sending; the probe proves neither an unsafe send nor a stale successful ACK. The timing is a deliberate immediate-after-reply fault boundary, not a claim about measured radio/network timing.

Proposal: pass/capture the expected generation through cleanup helpers and verify it before every subsequent internal command. Add faults after every individual cleanup/startup reply, not just after the first PTT-off. This is pre-existing helper behavior; outer release guards were strengthened in `ec801be`.

**A-G2 — Physical TX behavior and wire compatibility remain partially verified.**

All current evidence from this lane is software-fixture evidence on macOS/x64, Node `v26.13.0`. No physical CW, VOX, tuner or voice-memory operation, RF absence, client GUI, Windows or Linux run was performed. A future authorized dummy-load test should independently observe RF and radio display during each initiator's start, partial stop, disconnect, heartbeat loss and failed-cleanup recovery. Firmware-specific repeat/tuner/keyer behavior needs that validation.

**A-G3 — Optimistic RX/TX display state deserves a separate interface review.**

`src/broker.js:584` assigns `observedTx` from the accepted initiator type rather than a fresh status read; enabling VOX sets it false even if an existing explicit PTT trigger remains. `src/app/controller.js:346` uses that flag for the RX/TX display. `tests/telemetry-audit.test.js:46` explicitly documents the optimistic ACK assignment. This lane did not demonstrate a new ownership/safety bypass. It was referred to the coordinator for reconciliation with interface review instead of counted as a second confirmed defect.

## Feature verification matrix

“Verified” below means the indicated source/fixture behavior, not physical-radio validation. E = expected behavior source; I = implementation; T = existing tests/additional evidence.

| Feature | E / I | T and additional review | Result |
|---|---|---|---|
| One upstream association across downstream clients | README, architecture; `src/splitter.js:8`, session, server | Integration two-client association-count assertion; `app-native` controller path; callers inspected | Verified in loopback fixture |
| Native header/endian/credential encoding | Wire provenance docs; `protocol.js` | Independent literal byte vectors, mixed-endian sequence assertions | Verified for modeled vectors |
| Authentication and admission | Architecture; `server.js:250` | Invalid credentials/media, response-before-close, bounded reservations and preauth pools; timing-safe comparisons inspected | Verified in fixture; encryption/security reviewed by lane E |
| Same-IP isolation and media endpoint ownership | Architecture; `server.js:149`, `server.js:299` | Exact source port/ID checks, conflicting media endpoints, old associations | Verified in loopback fixture |
| Token renewal/expiration | Architecture; `session.js:119`, `server.js:250` | Cached renewal retry, expired preauth/token branches and timeout code inspected | Partially verified; sustained hardware renewal not rerun |
| CI-V fragmentation/noise/resynchronization | Architecture; `broker.js:12` | Fragmented/concatenated/truncated/oversized parser tests; parser bound inspected | Verified in fixture |
| Sequential FIFO dispatch and shared controller IDs | README, architecture; `broker.js:361`, `broker.js:415`, `broker.js:522` | Arrival-order private ACK/read tests; native integration, controller rewrite/restoration inspected | Verified for ordinary transactions |
| Correct reply completion/filtering | Architecture; `broker.js:522` | Echo/scope/unrelated command/prefix/ACK tests; timeout resets association | Verified for modeled replies; undocumented command shapes unverified |
| Shared frequency/mode updates | Architecture; `broker.js:492` | Selected/unselected VFO 25/26, DATA/filter conversion, private original reply and shared state tests | Verified in fixture |
| Shared scope subscriptions/output | Architecture; `broker.js:425`, `broker.js:527` | Local OFF/read handling, broadcast addressing, full scope integration | Verified in fixture; rendering reviewed elsewhere |
| Global/per-client queue bounds | Operations; `broker.js:74`, `broker.js:385` | Flood/queue-capacity tests; urgent stop displacement inspected | Verified in fixture |
| PTT initiator/release | README, architecture; `broker.js:53`, `broker.js:453`, `broker.js:596` | Contention, in-flight ON/queued OFF, owner disconnect, fresh RX release, native loopback handover | Verified except cleanup scheduling A-1 |
| CW initiator/release | Architecture; `broker.js:52`, `broker.js:586`, `broker.js:712` | Text lease, CW/CW-R stop, mode-aware USB skip, rejection, conservative 6 s/char deadline | Verified in fixture; RF/keyer timing unverified |
| VOX initiator/release | Architecture; `broker.js:56`, `broker.js:719` | Persistent lease, disconnect disable, uncertain-write obligation survives reconnect, PTT/VOX combinations | Failed concurrent cleanup scheduling A-1; other modeled paths verified |
| Voice-memory initiator/release | Architecture; `broker.js:55`, `broker.js:719` | Specific stop, retained ownership during arbitrary quiet/repeat intervals, partial-stop with PTT | Verified in fixture; same cleanup scheduling risk applies |
| Tuner initiator/completion/release | Architecture; `broker.js:54`, `broker.js:748` | Specific stop, three RX observations/grace, stale tuner reply, rejected start and incarnation guards | Verified in fixture; same cleanup scheduling risk applies |
| Multiple triggers / partial stops | Architecture; `broker.js:570`, `broker.js:698` | PTT + VOX, PTT + voice/tuner, rejected extra trigger, partial-stop immediate ACK | Verified in fixture |
| Competing writes/keying/audio discarded | README; `broker.js:351`, `broker.js:459`, `broker.js:625` | Admission and execution recheck, no post-TX replay, native integration | Verified in fixture |
| Urgent stop despite full queue | Safety intent; `broker.js:368` | Full queue stop accepted, owner queued mutations discarded | Verified for first stop dispatch; A-1 for following cleanup |
| Disconnect / heartbeat expiry release | README; `broker.js:635`, `server.js:382` | Real-UDP silent-owner loss test, media release and pending reply draining | Verified in fixture except A-1 |
| Reconnect and retained cleanup obligations | Architecture; `broker.js:266`, `broker.js:298` | Timeout drops stale work, remembered VOX cleanup, new association RX | Verified in normal fixture paths; helper guard gap A-R1 |
| Explicit release success/failure | Latest change; `broker.js:653` | Cleanup NG, RX-not-confirmed and disconnected/session replacement paths | Verified in fixture |
| Lease-ending successful stop ACK deferred until RX | User requirement; `broker.js:570`, `broker.js:613` | Original stop ACK suppressed until successful cleanup; no stale success on failed cleanup/disconnect/media/reset/reconnect | Verified in fixture |
| Immediate 0084 read/restoration after stop ACK | User requirement; `broker.js:613` | Broker regression sends read immediately from ACK callback, restores returned value, checks absence of NG | Verified in fixture |
| Deferred-request metrics/reset | User requirement; metrics and `broker.js:121`, `broker.js:613` | Active retained through cleanup; completion/cancellation once; reset while deferred excludes old totals | Verified by targeted tests; full statistics review lane B/F |
| Poll generation/incarnation guards | Architecture; `broker.js:725` | RX-before-start, stale tuner status, rejected start, association replacement | Verified in fixture |
| Every async cleanup-step generation fence | User requirement; `broker.js:712`, `broker.js:719` | Additional A-generation-boundary probe | Partially verified; helper guard gap demonstrated, unsafe send not demonstrated |
| Retired keying/audio and partial client frames | Architecture; broker invalidation; server watermark | Duplicate/wrap/reorder retirement, late gap fills, partial parser reset, generation replacement tests | Verified for observed packets; never-before-seen delayed epoch ambiguity remains documented |
| Graceful close/shutdown callers | README; `splitter.js:64`, `broker.js:759`, `controller.js:188` | Existing native controller close test; caller ordering and synchronous stop gate inspected | Partially verified; cleanup A-1 and physical release limitations remain |

## Verification performed and test quality

Executed:

```text
node --test tests/broker.test.js tests/protocol.test.js tests/safety-poll.test.js tests/server.test.js tests/integration.test.js tests/app-native.test.js tests/ping-native.test.js
91 tests passed; 0 failed/skipped/cancelled.

node docs/audits/2026-11-11/reproductions/A-release-read-interleave.js
Exit 0; asserted current scheduling defect and release=false.

node docs/audits/2026-11-11/reproductions/A-generation-boundary.js
Exit 0; asserted cross-generation queue admission, no send after disconnect.
```

Reviewed all of `broker.js`, `protocol.js`, `session.js`, `server.js`, `stream.js`, `splitter.js`, relevant controller start/stop callers, telemetry state interaction, README/architecture/operations/validation, and the targeted tests' actual assertions. Tests were read as evidence of their assertions, not as proof of untested product behavior.

The server native-client test fixture deliberately constructs independent packets, and integration tests use real loopback UDP; these are stronger than testing production encoders against themselves. In contrast, the broker unit `Radio` auto-replies in a microtask and the baseline `Server` merely records deliveries. Those doubles make cleanup commands fast, hide nonessential traffic stealing the interval between awaited cleanup commands, do not prove UDP delivery, and cannot establish firmware/RF semantics. The new A-1 probe retains the real broker state machine and deliberately stalls the intervening unrelated request.

No source fixes, commits, deployments, dependency changes or destructive actions were performed. Full lint/static/build/platform verification belongs to the coordinator and the other review lanes.

## Official protocol check

Consulted the [Icom IC-7300MK2 CI-V Reference Guide](https://icomuk.co.uk/files/icom/PDF/productAdditionalFile/IC-7300MK2_ENG_CI-V_0.pdf), available from the [Icom support entry](https://www.icomjapan.com/support/manual/4486/). Its command tables identify `1C 00` RX/TX, `1C 01` tuner, `16 46` VOX, `17` CW messages and `28 00` voice memory. Those match the implemented explicit initiator families. The manual distinguishes tuner enabled from active tuning and specifies separate scope-enable and scope-output controls. This check establishes documented CI-V intent; it does not document the independently reconstructed native UDP envelope or verify physical firmware behavior.
