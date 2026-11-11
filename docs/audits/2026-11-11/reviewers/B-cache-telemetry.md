# Reviewer B — cache, shared telemetry and statistics

Audit date: 2026-11-11. Source: `ec801be1af4f0e05e5b156848541a788d7a704b0` (`v0.8.1` package metadata). Initial worktree was clean. Execution platform: macOS (`darwin`), x64, Node `v26.13.0`.

This assessment was formed independently before receiving other reviewers' findings. The coordinator was sent the first-pass result before cross-review. No production management endpoint, Pi, radio, credentials or media were accessed. No implementation files, dependencies, commits or deployment state were changed. The only additions owned by this lane are this report and the two `B-*.js` reproduction files.

## Assessment

The inspected cache/coalescing implementation preserves FIFO mutation barriers and requester addressing, and the telemetry scheduler has bounded per-query work and age checks. The verified fixture scenarios do not show a cache-driven TX-safety failure. Statistics history is less reliable: automatic reconnect drops upstream transport history, and an explicit application reconnect drops admission-event history. Telemetry fallbacks also omit the detailed miss reasons. One read-cache validator accepts unsupported IF-filter-shape values, and an existing test explicitly endorses the wrong range.

These conclusions concern source and isolated fixtures. Physical refresh timing, real-radio reply variants and RF safety under faults remain outside this lane's verification.

## Confirmed defects

### B-01 — historical counters disappear at reconnect boundaries

**Severity:** Low (P3; reconciled with the coordinator as a diagnostic-only defect). **Confidence:** High. **Affected feature:** statistics accumulation and diagnostics.

**Source locations:** `src/broker.js:152–157`, `src/icom-lan/session.js:62–72`, `src/icom-lan/stream.js:24`; application aggregation at `src/app/controller.js:218–223` and `src/app/controller.js:279–285`; admission snapshot at `src/cli.js:66–74`.

**Expected:** statistics for the period since application start/latest reset retain historical transport and admission events across reconnects. Live client, queue and connection gauges should reflect the new connection. This expectation comes from `docs/interfaces.md:173–177` and the audit's explicit reconnect-accumulation requirement.

**Actual, automatic upstream reconnect:** `IcomSession.begin()` replaces all three `IcomStream` objects, whose counters start at zero. `Broker.metricsSnapshot()` reads only the replacement objects. Nothing transfers the old values to cumulative totals; the BrokerMetrics physical totals continue across that same automatic reconnect.

**Actual, explicit application reconnect:** `finishStop()` retains only `raw.cache` and `raw.metrics`. It drops `raw.admission`. The subsequent instance exposes the new server's zero-valued admission counters, while `statisticsStartedAt` stays unchanged. The same admission-history loss occurs on Stop before Start.

**Reproduction:** run the first two tests in [B-statistics-boundaries.js](../reproductions/B-statistics-boundaries.js):

```sh
node --test docs/audits/2026-11-11/reproductions/B-statistics-boundaries.js
```

The first probe runs an actual Splitter against the repository's loopback IcomPeer fixture, increments an audio stream's malformed-packet counter through its real parser, then induces an isolated automatic reconnect. Observed `transport.audio.malformed: 1 → 0`, while physical totals persist. The second probe creates a real NativeServer pre-authentication entry through its receive path, advances its fixture clock until that entry expires, then invokes the real AppController reconnect path. Observed `admission.preAuthExpired: 1 → 0`, with an unchanged statistics window. The service factory binds only loopback, independently of the validation-only in-memory app settings.

**Impact:** reconnects erase evidence of the packet problems that may have caused recovery. Period comparisons and diagnostic exports can misleadingly show healthier transport or fewer refused/expired clients without a user statistics reset. This finding does not imply packets are delivered incorrectly.

**Provenance:** pre-existing relative to HEAD. The transport snapshot is traced by `git blame` to `5dae6cf` (2026-11-08). The application aggregation omission is traced to `9bc11de` (2026-11-08). This is not attributed to the latest deferred-stop change.

**Smallest practical fix:** retain retired upstream stream counters before their objects are replaced, expose cumulative-plus-current values, and carry historical admission counters alongside cache/metrics in AppController. Keep live gauges separate. Reset must clear both retained totals and current counters without changing streams or their packet sequencing. An alternative is explicitly separate per-association and application-period counters, but silently changing the existing application-period meaning would not meet the requested behavior.

**Regression needed:** generate at least one real parser loss/duplicate/malformed event, reconnect automatically, and require the total to remain monotonic; repeat across two reconnects. Test explicit app reconnect and Stop/Start for all three admission counters. Reset before and during recovery must yield zero historical counters, with no later resurrection or double aggregation.

**Cross-review:** after this lane's independent first pass, the coordinator reported an independently executed F-lane duplicate-counter reproduction (`1 → 0`, physical count `5 → 10`). The admission case was also found independently by lane D. The B probes above provide separate parser/lifecycle evidence.

### B-02 — telemetry fallbacks bypass all detailed cache-miss reasons

**Severity:** Low (P3). **Confidence:** High. **Affected feature:** diagnostic reason counters.

**Source locations:** `src/broker.js:190–199`, `src/broker.js:433–451`, `src/telemetry.js:99–114`, `src/metrics.js:20–22`.

**Trigger:** enable telemetry, leave the S-meter sample bank cold, and admit one eligible `1502` client query. Stale and admission-epoch fallback paths have the same missing instrumentation.

**Expected:** the fallback is counted as a physical eligible miss and has a bounded reason such as `absent`, `expired` or `admission_epoch`. Detailed reasons are advertised in `docs/operations.md:236–239` and remain present in the snapshot schema.

**Actual:** the telemetry branch sets `cached = null` instead of calling `cachedReply()`. `SharedTelemetry.lookup()` returns only a sample or null and never records a miss reason. Consequently `cache.misses = 1`, the query's `fallbacks = 1`, and every `metrics.reasons.misses` field is zero. The physical read and its logical accounting still occur correctly.

**Reproduction:** the third test in [B-statistics-boundaries.js](../reproductions/B-statistics-boundaries.js) prints these exact values and asserts the observed gap. It uses an in-process Broker with a cold sample bank and no sockets.

**Impact:** investigators cannot determine whether telemetry fell back because it was cold, stale or blocked by ordering. Counters under-report misses as soon as telemetry is enabled. No incorrect meter reply was established by this probe.

**Provenance:** introduced with the shared-telemetry branch in `47cf947` (2026-11-11), before current HEAD. Existing telemetry tests assert fallback totals but do not require corresponding reasons.

**Smallest practical fix:** return or compute a bounded telemetry lookup miss reason, then record it once when a client actually falls back at the FIFO head. Preserve the existing reset suppression flag; do not count background polls or cache-disabled/noneligible commands as eligible misses.

**Regression needed:** cold sample, exact 300/1000 ms expiry, mutation admission barrier and reconnect invalidation each produce one appropriate miss reason and one physical fallback. Existing hit, physical-total and reset-conservation assertions must continue to pass.

### B-03 — IF-filter-shape cache validation accepts unsupported values

**Severity:** Low (P3). **Confidence:** High. **Affected feature:** read-cache reply validation and coalescing of malformed replies.

**Source locations:** `src/read-cache.js:30–32`, cache population at `src/broker.js:232–240`, and incorrect positive oracle at `tests/read-cache.test.js:65`.

**Expected:** the `16 56` IF-filter-shape getter accepts only the two values documented by Icom. The [official IC-7300MK2 CI-V guide, page 6](https://icomuk.co.uk/files/icom/PDF/productAdditionalFile/IC-7300MK2_ENG_CI-V_0.pdf#page=6) defines `00` for SHARP and `01` for SOFT. This was checked against the primary document during this audit.

**Actual:** the validator special-cases subcommand `56` with a decimal maximum of 31. It accepts otherwise well-framed BCD values from 2 through 31. The existing canonical-values test explicitly accepts `165631`.

**Trigger and reproduction:** run [B-read-cache-shape.js](../reproductions/B-read-cache-shape.js). Two clients send the getter before its reply. Inject the malformed reply value `02` into the isolated Broker:

```sh
node --test docs/audits/2026-11-11/reproductions/B-read-cache-shape.js
```

Observed: the validator returns true, one physical read supplies two private replies, and the second reply is a cache hit containing the unsupported value. Expected: that reply must not populate the cache or satisfy the queued second client's read. Handling of the first malformed raw response is a separate protocol-validation concern.

**Impact:** an unsupported radio/transport reply can be amplified to other clients for the settings TTL (250 ms by default). This is a robustness defect requiring a faulty reply; no evidence shows that normal MK2 firmware emits these values, and this getter does not initiate TX.

**Provenance:** pre-existing, traced to the initial cache change `d2c6131` (2026-11-08). The test shares the implementation's mistaken range and therefore cannot detect it.

**Smallest practical fix:** remove the `56 → 31` exception so this binary getter uses maximum 1; change the positive test to 00/01 and require 02 and 31 to be rejected. Do not widen the allowlist.

**Regression needed:** test both legal values and the unsupported boundary values against the validator, then require the second client to perform a fresh physical read after a malformed first response. This is a narrow validation change with low compatibility risk under the published protocol.

## Verification matrix

Statuses below describe this lane's evidence, not physical-radio certification. “Verified (fixture)” means the relevant behavior was inspected and exercised locally. Expected behavior comes from `docs/architecture.md` (ordered cache and safety boundaries), `docs/operations.md` (TTLs/accounting), `docs/interfaces.md` (sampling/statistics semantics), and the cited Icom guide where specified.

| Feature / expectation | Implementation | Existing tests inspected and run | Additional verification / result |
| --- | --- | --- | --- |
| Exact reviewed getter shapes; setter/network-menu exclusion | `read-cache.js:5–45`, `broker.js:42–65` | `read-cache.test.js` allowlist, malformed shape and setter cases | Primary-guide spot check of bare settings, meter/RX-zero, LAN routing and scope formats. **Partially verified; B-03 fails one range.** Full firmware/mode reply matrix unverified. |
| Family TTLs, exact expiry, per-query inheritance/override/zero/global-off | `read-cache.js:47–103`, `broker.js:161–165,190–240` | `read-cache.test.js`, `cache-broker.test.js` | Read both option-normalization and runtime callers; positive telemetry TTL replacement is explicitly disclosed by settings and interfaces docs. **Verified (fixture).** |
| In-flight/queued sharing and private controller addressing | `broker.js:190–249,432–445` | `cache-broker.test.js`, `cache-integration.test.js`, `telemetry.test.js`, `telemetry-audit.test.js` | Loopback UDP tests exercise independent addresses; malformed 1656 sharing additionally exercised. **Verified for valid replies (fixture); malformed range B-03 fails.** |
| Reads stay ordered across admitted/dispatched/completed mutations | `broker.js:174–240,331–341,390–400,449–451,564–565` | FIFO barrier, late pre-write, rejected-write and notification cases | Inspected epoch versus coherence-epoch separation and internal polling callers. **Verified (fixture).** |
| Lifecycle/session/media-generation invalidation | `broker.js:244–280,415–423,522–565` | Cache reconnect, inactive client, media-generation and stale-reply cases | Actual loopback automatic reconnect in B probe. **Verified cache invalidation (fixture); transport totals fail B-01.** |
| 100 ms S-meter/RXTX, 500 ms ADC targets; positive telemetry lifetimes become 300/1000 ms sample limits | `telemetry.js:3–10,34–39,120–145`, `broker.js:117,724–755` | `telemetry.test.js`, `telemetry-audit.test.js` | Reviewed timer, dispatch and completion scheduling. Fake-clock tests prove 22 RX reads/s in a fast fixture. **Verified scheduling model; actual hardware timing unverified.** |
| 100 ms Power/SWR/ALC polling only with validated TX sample | `telemetry.js:39,120–130` | 52 reads/s TX fixture; optimistic ownership cannot enable meters | Source distinguishes validated sample from optimistic ownership/observed flag. **Verified (fixture); RF and physical timing unverified.** |
| Locally supplied TX-meter zeros require fresh validated RX state | `telemetry.js:34–39,99–118` | Exact 299/300 ms boundary, private reply and invalid/pre-notification state cases | Icom guide page 5 independently supports RX zeros for the three meters. **Verified (fixture/document).** |
| Cold/stale/ordering fallbacks and bounded jobs/no catch-up bursts | `telemetry.js:43–97,120–130`, `broker.js:399–400,449` | Slow-radio, coalescing, mutation and old-epoch cases | Reviewed key/job replacement and cancellation paths; B cold probe. **Read behavior verified (fixture); detailed reasons fail B-02.** |
| Logical/eligible accounting, admission conservation, physical purpose totals, private completion | `metrics.js:29–113`, `broker.js:121–157,345–348,406–478,613–622` | `metrics.test.js`, `broker-metrics.test.js`, selected `broker.test.js` | Checked eligible denominator and distinction between paid background traffic versus local answers. **Verified (fixture), except B-01/B-02 instrumentation.** |
| Histogram bins, gateway RTT vs queue wait, interval rates and bounded history | `metrics.js:4–17`, `controller.js:302–335` | `metrics.test.js`, `broker-metrics.test.js`, `app-controller.test.js` | Tests use different clocks for queue and reply timing and inspect interval count/sum deltas. **Verified (fixture); real multi-platform/event-loop behavior unverified.** |
| Reset with queued/in-flight work preserves replies/cache and suppresses old logical/cache totals | `broker.js:121–137`, `metrics.js:67–103`, `controller.js:258–277` | `statistics-reset.test.js`, `app-controller.test.js` | Reviewed metrics-window identity and per-item suppression. **Verified (fixture).** |
| Deferred TX-stop ACK waits for cleanup; reset/disconnect/generation change cannot resurrect totals or stale success | `broker.js:570–622,635–695` | Four selected `broker.test.js` tests, including reset during deferred stop | Targeted run verifies success/failed cleanup, disconnect/media/session fencing and reset preservation. **Verified for tested fixture paths.** Broader cleanup-generation analysis belongs to lane A. |
| Cache and logical totals persist across app reconnect; live gauges are current | `controller.js:12–43,218–223,279–286` | `app-controller.test.js` | Reviewed aggregate counts and histogram merge separately from gauges. **Verified cache/logical totals (fixture); admission totals fail B-01.** |
| All historical transport counters persist through automatic reconnect | `session.js:62–72`, `broker.js:156–157` | No existing test enforces monotonic history at stream replacement | Real loopback reproduction. **Failed: B-01.** |
| Bounded entries, labels, query jobs and logical client queueing | `broker.js:75–83,238–241,385–400`, `metrics.js:54–59`, `telemetry.js:53–65,120–130` | Cache entry cap, bounded metric labels and slow-radio tests | Source review confirms finite catalog/job bank and client admission bounds. **Verified bounds (fixture/code); combined media capacity at scale belongs to lane C.** |

## Commands and observed results

```sh
node --test tests/read-cache.test.js tests/cache-broker.test.js tests/cache-integration.test.js tests/telemetry.test.js tests/telemetry-audit.test.js tests/metrics.test.js tests/broker-metrics.test.js tests/statistics-reset.test.js tests/app-controller.test.js
```

Observed: **86 tests passed**, zero failures/skips; 1.47 seconds in this run.

```sh
node --test --test-name-pattern='statistics reset during a deferred stop|lease-ending OFF ACK|failed lease cleanup|deferred stop replies' tests/broker.test.js
```

Observed: **4 selected tests passed**, zero failures/skips; 0.24 seconds. This was a targeted run, not a claim that all broker tests were rerun by B.

The audit reproduction commands above passed **4 assertions of the current defective behavior** across two files. Their green exit status establishes reproduction, not correctness; fixing the defects should require changing those assertions into the expected invariants.

The coordinator subsequently reran both reproduction files independently and confirmed all four observed cases, and checked the Icom `1656` range against the official guide. These are accepted source/fixture findings, with diagnostic-only impacts classified P3 rather than an operational packet-loss or TX-safety failure.

No production commands, stress tests, physical TX, real-radio associations, platform package builds, or production statistics resets were performed by B. Repository-wide lint/check/full-suite results are owned by the coordinator/other lanes.

## Coverage gaps and remaining risks

- Existing cache/telemetry tests are unusually specific about barriers, privacy, exact expiry and slow replies, but most use a manually advanced clock and EventEmitter radio. They validate ordering and calculations, not actual 100 ms service levels or RF behavior.
- The real-UDP cache integration tests exercise valuable transport boundaries but still use a synthetic firmware oracle. A measured read-only capture across operating modes/filters, front-panel notifications and firmware versions is needed to validate every catalog entry; do not infer this from current passing shape tests.
- The IF-filter-shape positive test demonstrates shared assumptions between implementation and tests. A table-driven legal/illegal-value review against the primary guide is advisable before extending the catalog. This does not justify speculative new allowlist entries.
- The three historical admission counters are definitely lost at explicit reconnect. Client-row stream counters are live per-client gauges/records and may legitimately disappear when that client disconnects; they should not be indiscriminately summed as historical data.
- Telemetry-only counters intentionally cover the current splitter instance, according to `docs/interfaces.md` and the UI footnote. Their reset at explicit app reconnect is therefore **not** included as a defect.
- The TUI labels the eligible-only request rate as “Client requests” (`src/app/tui.js:64`), while desktop correctly labels the graph as cache-eligible demand. This is a low-impact label mismatch, handed to lane D; it is not a cache denominator calculation defect.
- No physical-radio conclusion is drawn from archived hardware reports or prior green tests. Future physical tests must respect the audit's no-TX/no-settings-change boundaries; TX refresh/cleanup validation needs a separate explicitly authorized controlled fixture/hardware session.

## Proposed priority

1. Preserve historical transport/admission statistics at lifecycle boundaries, with reset/reconnect regressions. Small-to-moderate effort; moderate accounting compatibility risk if old and new totals are accidentally aggregated twice. This improves trustworthy diagnosis of intermittent loss.
2. Tighten `1656` validation and replace the incorrect positive oracle. Small effort and narrow protocol-compatible impact.
3. Add bounded telemetry fallback miss reasons. Small effort; low runtime risk, with care around reset suppression and double counting.

Implementation and deployment decisions remain with the user.
