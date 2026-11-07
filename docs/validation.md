# Validation record

Recorded 2026-11-07. Local macOS/x64 tests used Node.js 22.23.4 and 26.13.0. Synthetic tests and native
application packet interoperability pass within the coverage below. This is not
a claim that every client, operating system, firmware revision or physical TX
failure mode has been verified.

## Reproduce

```sh
npm ci
npm run lint
npm run check
npm test
npm audit
npm pack --dry-run
npm run test:capacity -- 32 2000
npm run test:capacity -- 128 5000
node scripts/wfweb-smoke.js --run --binary ../wfweb/wfweb
```

`npm ci` installs development lint tooling only. Runtime has no package
dependencies. `check` runs Node syntax checks; ESLint provides static linting.
The source is plain JavaScript, with no compiler/typecheck stage. These checks do
not establish protocol correctness by themselves.

Local execution: **78 tests passed, zero failures/skips**, comprising 35 broker,
4 configuration, 10 UDP integration, 7 lifecycle/operations, 5 packet/transport,
and 17 native-server tests. The earlier 73-test suite also passed
on Node.js 22.23.4; subsequent cases cover the hardware-probe script against a synthetic radio
and ensure owner stop requests survive full command queues without late
PTT acknowledgements rearming audio. ESLint and syntax checks passed. `npm audit` reported
zero vulnerabilities, including development tooling. A minimatch override pins
11.0.5 to address GHSA-g3hv-75wg-m249 in the development dependency tree.

## Interoperability matrix

| Endpoint/client | Environment and format | Observed evidence | Limits |
| --- | --- | --- | --- |
| Independently encoded synthetic radio | Localhost UDP on macOS | Login, one upstream association, control, PCM, 475-point scope and failure scenarios | Synthetic; no physical radio or RF |
| Unmodified PiRO-derived `IcomSession` clients | Localhost; same-IP and same-controller clients; codec 4/48kHz mono | Concurrent sessions, private ACK/read replies, shared audio/scope, ordering, disconnect and TX arbitration tests | Transport clients, not full browser UI/application validation |
| Unmodified sibling wfweb executable | macOS/x64 against synthetic radio; codec 4/48kHz mono | Authentication, both media handshakes, semantic frequency (`25`) and mode/data/filter (`26`) replies, 300 audio packets and 60 scope packets forwarded to client over at least 6 seconds of stable polling | Playback, waterfall rendering, RF and TX interoperability not verified |
| wfview standalone application | Intended native Icom LAN | Not executed | No application interoperability claim |
| Icom RS-BA1 application | Windows | Not executed | No application interoperability claim |
| rigplane / Radio WebOp / sdroxide | Native LAN candidates | Discovered and researched | Not executed against splitter |
| Physical IC-7300MK2 at `10.0.1.25` | Actual LAN | Earlier basic ping only | No new splitter radio session, receive/control or dummy-load TX test; readiness confirmation pending |

The implemented audio format is codec 4, mono S16LE at 48 kHz; other formats are
explicitly rejected. A tested PCM client does not prove every native Icom client
will negotiate that format. The wfweb smoke script uses fixture credentials,
isolated temporary preferences, and a synthetic radio; it does not connect to
hardware or request TX.

## Capacity measurements

The benchmark starts the synthetic radio, service and all clients in one process
on loopback. Counts below are aggregate packets delivered to clients.

| Clients | Upstream sessions | Audio received/expected | Scope received/expected |
| --- | --- | --- | --- |
| 32 | 1 | 6,272 /6,272 | 608 /608 |
| 128 | 1 | 62,720 /62,720 | 6,272 /6,272 |

The initial 128-client run delivered 92.597 Mbps of audio payload and reported 191 MiB RSS.
A final repeat delivered all 61,440 audio and 6,144 scope packets, with one upstream
session, 90.643 Mbps audio payload and 202.2 MiB aggregate-process RSS.
RSS includes the simulator, splitter and all synthetic clients in the benchmark
process. These are successful workloads, not measured maximum capacity, physical
LAN throughput, real-radio latency or RF quality. The benchmark explicitly raises
the admission memory budget for the requested client count; the normal default
128-MiB conservative reservation admits roughly 18 clients. Raise
`ICOM_MEMORY_BUDGET_MB` for larger deployments and measure the actual workload.

## Platform matrix

| Platform | Evidence |
| --- | --- |
| macOS | Local x64 Node 22.23.4/26.13.0 suite, CLI lifecycle, clean package installation/help and native wfweb smoke; hosted macOS CI also passed Node 22 and 24 |
| Linux | GitHub Ubuntu CI passed Node 22 and 24: lint, syntax, automated tests, package inspection |
| Raspberry Pi | No actual installation, capacity or lifecycle run yet |
| Windows | GitHub Windows CI passed Node 22 and 24: lint, syntax, tests and package inspection; one SIGTERM test is skipped per job. Console Ctrl+C and installed Task Scheduler stop remain unverified |

The initial 73-test matrix passed all six hosted jobs in [Verify run 42408064183](https://github.com/s53zo/IC7300MK2_Lan_Splitter/actions/runs/42408064183),
for source commit `babc6dc38d42cd82996f26a12510a65057aacff2`.
[Current verification runs](https://github.com/s53zo/IC7300MK2_Lan_Splitter/actions/workflows/ci.yml)
record the exact source and results for subsequent regressions. These execute real
UDP service lifecycle tests on each operating system. They do not establish
actual Raspberry Pi operation or native Windows console/service stop behavior.
Service templates are supplied for systemd, launchd and Windows Task Scheduler;
the launchd plist passes `plutil -lint`. Windows Task Scheduler's forced stop is
not a guaranteed graceful TX release.

## Requirement-to-evidence checklist

| Requirement | Evidence inspected | Status and residual scope |
| --- | --- | --- |
| One upstream native session, multiple unchanged clients including same IP | `tests/integration.test.js`, native-server association tests, benchmark session counter, wfweb smoke | Proven synthetically and with one native application packet path; hardware confirmation remains |
| Audio, complete 475-point scope and shared state to all clients | Integration fanout/identity assertions; broker scope broadcast and virtual subscription tests; measured fanout | Proven for supported PCM and synthetic scope; physical source/rendering not measured |
| Private replies despite shared controller IDs; late ACK isolation | Broker and integration shared-address, query/ACK matching, timeout/reconnect tests | Tested; arbitrary undocumented CI-V command coverage is not asserted |
| Arrival order and exclusive TX; discard competing changes/audio | Broker arrival/execution checks and real-UDP TX tests | Tested for modeled PTT, CW, VOX, voice memory and tuner paths; real-client TX not executed |
| Owner disconnect/heartbeat release with receive confirmation before handover | Broker cleanup tests; UDP heartbeat-loss test; CLI SIGTERM test | Tested against simulator; physical unkeying/RF not established |
| Reconnect resets session/ownership and never intentionally replays old work | Timeout, media-release, replay invalidation, media-generation and partial-frame tests | Tested; native packets have no TX-epoch field, leaving a delayed never-before-seen packet ambiguity within one association |
| Loss/reorder/duplicates/wrap/slow clients/bounded resources/auth failures | Packet/transport and 17 server tests; broker overload and integration retransmission cases | Tested within configured windows and synthetic faults; hostile sustained-load/long-soak testing remains |
| Explicit supported/rejected negotiated formats | Server unsupported-format test and capability literal tests | Codec4/mono/48 kHz supported; other formats deliberately rejected |
| Linux/macOS/Windows operation | Local macOS suite and lifecycle checks; multi-OS CI definition and service examples | Linux/macOS/Windows CI and local macOS verified within recorded scope; Raspberry Pi hardware and native Windows console/service stop remain |
| Hardware receive/control and brief dummy-load TX | Requirements authorization and documented hardware procedure | Not executed; availability and dummy-load readiness still required |
| Secret handling, install/config/docs and source attribution | Config validation/redaction tests, CLI help, package inspection, README/operations/research/NOTICE | Implemented and locally checked; no real password is included in repository examples |

## Behavior limits to preserve

- Startup/reconnect confirms receive and enables scope/waveform output before
  ordinary client work. One client's subscription OFF does not disable shared
  upstream scope. Span/mode and physical radio settings remain shared.
- Observed queued CI-V/audio are retired at lease boundaries using a sequence
  watermark; upstream TX replay data are invalidated. A native packet does not
  identify its TX epoch, so arbitrary never-before-seen delayed packets cannot
  always be classified as old within a continuing association.
- CW auto-completion waits conservatively 6 seconds per accepted character at
  6 WPM, then three receive polls. Explicit stop begins cleanup sooner. This can
  delay handover after short or fast keying.
- Voice-memory repeat retains ownership until explicit stop/disconnect. Tuner
  cleanup uses its own stop command; a quiet PTT interval alone is insufficient.
- Radio-link loss and forced process termination cannot guarantee delivery of
  stop commands. Physical front-panel/keyer/microphone control is not atomically
  interlocked by this service. Verify a suitable radio-side TX timeout.

## Hardware procedure

1. Confirm no other direct remote session is operating the radio.
2. Confirm network settings and obtain credentials at runtime without packet dumps
   or committed secret files.
3. Run multiple unchanged clients through the splitter. Record firmware, client
   versions, actual negotiated audio format and port settings.
4. Verify receive audio, scope, shared tuning, individual disconnect and clean
   stop/reconnect. Record on-radio observations separately from CI-V replies.
5. Before TX, confirm a suitable dummy load, power and timeout limits. Brief
   dummy-load TX was authorized; network reachability does not establish readiness.
6. Test exclusive TX, rejected competing changes, owner disconnect, physical
   unkeying and receive confirmation before handover. A PTT-off ACK is not an RF
   power measurement.

Earlier PiRO MK2 hardware records are useful protocol history, not new splitter
hardware evidence. Long soak, firmware-specific timing, audible audio quality,
waterfall rendering, RF quality and process/network-failure behavior on the
physical radio remain explicit validation gaps.

## Opt-in hardware probe

`scripts/hardware-smoke.js` provides a repeatable two-client hardware check. It
uses the normal runtime environment/password file and refuses to start without
`--run --radio-available`. It defaults to identity/frequency/mode queries and
audio/scope observation; it does not retune or change modulation routing. Add
`--tx --dummy-load` only after independently establishing load readiness for a
brief PTT ownership/disconnect check. It cannot measure RF output or establish
firmware version from those protocol checks. This probe has been syntax/guard tested and both its receive/control and PTT
procedures passed end-to-end tests against the independent synthetic radio. It
has not been run against physical hardware.
