# Verification and reproduction guide

All commands below are run from the repository root unless an isolated snapshot is specified. They use in-memory or 127.0.0.1 fixtures, generated temporary profiles and synthetic credentials. **Do not substitute the production IP or real credentials.** They are audit evidence, not fixes.

## Baseline and platform evidence

| Check | Result | Boundary |
| --- | --- | --- |
| `npm test` |273 pass,0fail |Node26.13.0 macOS/x64; relevant existing assertions inspected by six reviewers |
| `npm run lint` |pass |Repository configured ESLint paths; audit JS also checked separately |
| `npm run check` |pass |Syntax/static script scope, not formal verification |
| `npm pack --dry-run --json --cache /tmp/icom-full-audit-npm-cache` |pass |Default npm cache first failed EACCES; isolated cache avoids changing user ownership |
| `npm audit --json --cache /tmp/icom-full-audit-npm-cache` |0 known advisories |Current lockfile and current registry response only; no no-vulnerability claim |
| `npm run web:smoke -- --output=/tmp/icom-full-audit-web` |pass |Ordinary sandboxed HTTPS browser,90fields,2nativefixtureclients, oneupstream, exactmedia, resetconfirm/cancel, settings/reconnect and logout/close; no RF |
| Fresh standalone build in isolated ec801be snapshot |pass |OfficialNode26.13.0 darwin/x64 archive checksum checked against official SHASUMS256; Homebrew's same-version Node initially failed because SEA is disabled |
| `node scripts/release-smoke.js --executable <fresh-executable>` |pass |Extractedstandalone2clients, password-file config, exactPCM/scope, oneupstream, no TX |
| `python3 scripts/tui-smoke.py --executable <fresh-executable>` |pass |RealPTY/macOS explicitTUI;5views/passwordmask/validation/export/terminalrestore; not Linux no-argument mode |
| `node scripts/tui-native-smoke.js --executable <fresh-executable>` |pass |Two realnativefixtureclients, savedautoload, coalescing, ping, exactmedia, syntheticTXconfirm/cancel/release; no RF |
| Fresh `CSC_IDENTITY_AUTO_DISCOVERY=false node scripts/desktop-build.js` in isolated snapshot |pass |MacIntel DMG, realapp/ad-hoc-signature, sourceec801be, no notarization/publish |
| `node scripts/desktop-installed-smoke.js` in isolated snapshot |notpassed |DMGmount/copy/signature and GUIboot work; fixture credential save denied by OSKeychain(-25308), then readiness timeout. No encryption bypass attempted |
| Current-source GitHub Verify |6/6jobs success |Windows/macOS/Ubuntu with Node22/24, commit ec801be; fetched run43094197886 |
| Publishedv0.8.1 GitHub Release |10/10jobs success |Older9d9e666 nativebuild/smoke evidence; fetched run42516452856; does not validate current Linuxweb/telemetry/reset/ACK binaries |
| Pi read-only SSH |unverified |Two attempts timedout duringbannerexchange; no radioassociation/servicechanges performed |

Fresh builds ran in an isolated archive snapshot with read-only Git identity pointed at the existing commit and dependencies reused. Build metadata identifies ec801be; old .release/dist0.1.0 artifacts were deliberately not used as current evidence. Build flags never requested publishing. Large temporary logs, installers and screenshots remain outside this audit directory; only compact numerical/provenance summaries are retained.

## Audit probes and exit-status meanings

Most probes assert the **current observed defect** and exit0 when reproduced. Two F tests assert the **desired invariant** and deliberately exit1 on current code. A green probe that asserts a counterexample does not mean the feature is correct; an expected failing regression is not part of the 273-test baseline. Check each expectation explicitly.

| Command (`node` unless shown) | Expected current exit | Observation / finding |
| --- | --- | --- |
| `docs/audits/2026-11-11/reproductions/A-release-read-interleave.js` |0 |03→release1c0000→client04→timeout;releasefalse,VOXdisablenotsent. AUD-01 |
| `docs/audits/2026-11-11/reproductions/A-generation-boundary.js` |0 |OldCWcontinuationqueues17ff taggednewgeneration afterdisconnect;no send demonstrated, recovery purges it. RiskR2 |
| `--test docs/audits/2026-11-11/reproductions/B-statistics-boundaries.js` |0,3checks |Malformed1→0 automaticreconnect;preauthExpired1→0 appreconnect;telemetrymiss1 withallreasoncounts0. AUD-05/06/09 |
| `--test docs/audits/2026-11-11/reproductions/B-read-cache-shape.js` |0,1check |Unsupported1656value02accepted;1physicalread supplies2privateclients. AUD-08 |
| `docs/audits/2026-11-11/reproductions/C-transport-probes.js` |0 |Longblackhole loses1000recoveredpayloads;10000heldupstreamsends;downstreamslowpeerbounded;ordinarywrapcorrect. AUD-03/04 plus positiveisolation |
| `docs/audits/2026-11-11/reproductions/C-concurrent-media.js` |0 |8clients,actualactive sharedtelemetry,03 optedout ofcache;allqueryreplies and emittedmedia delivered, zero broker timeouts;3s boundedworkload |
| `docs/audits/2026-11-11/reproductions/D-interface-probes.js` |0 |FalseTUIStart/Reconnectsuccess, admissionhistoryloss, killedfixture subprocesssavewindow, modeledBFCachegap. AUD-06/07 and risksR3/R4 |
| `docs/audits/2026-11-11/reproductions/E-headless-failed-release.js` |0 |RealchildCLI onPOSIX exits0 after rejectedcleanup;fixturePTTtrue;genericfailurestatus butno explicitRX-unconfirmedwarning. AUD-02 |
| `--test docs/audits/2026-11-11/reproductions/F-transport-reconnect.js` |**1** |Desiredcounterconservationfails:duplicates1→0 whilephysical5→10 andmediarecovers. AUD-05 |
| `--test docs/audits/2026-11-11/reproductions/F-delayed-audio-lease.js` |**1** |DesiredabsoluteoldPCM exclusionfails onsameassociation;documented unseen-UDP limitation, not newly keyingTX. RiskR1 |
| `node scripts/benchmark.js 128 2000` |0 |Shortloopbackfanout, elevatedadmissionbudget,1upstream. Not defaultclientlimit or Picapacity |

Coordinator independently executed all ten audit scripts and inspected their asserted expectations. AUD-10 was substantiated by fresh extracted archive contents and staging allowlists, not a failing runtime probe. Cross-review by C/F corroborated A/E findings after independent first passes; B/F independently found transport history loss and B/D independently found admission loss. Duplicate findings were merged in the consolidated report.

The first version of the C concurrent probe mistakenly combined telemetryEnabled=true with cacheEnabled=false. Master cache disable also disables telemetry. That run supports uncached-control/media delivery only. The corrected probe uses cacheEnabled=true plus cacheQueryTtls03=0 and asserts active telemetry and nonzero scheduled physical polls; only corrected evidence supports simultaneous sampling/control/media claims. Measured query counts/gaps vary by host scheduling; compact coordinator results are in workload-results.json.

## Primary documentation and source distinctions

- [Official Icom CI-V guide](https://icomuk.co.uk/files/icom/PDF/productAdditionalFile/IC-7300MK2_ENG_CI-V_0.pdf): p5 meter definitions establish S-meter/OVF and zero Po/SWR/ALC replies in RX; p6 limits IF-filter shape1656 to00/01. The coordinator fetched the document and its table screenshot for page6. These are CI-V value semantics, not a complete OEM LAN wire specification or a guarantee of polling cadence.
- [Official Icom basic-manual page](https://www.icomjapan.com/support/manual/4459/) and existing research/provenance map distinguish radio menus/LAN setup from reverse-engineered native session envelopes. No new unsupported wire-protocol claim is treated as official specification.
- Existing docs/hardware-results records and prior deployment notes are historical supporting material, not fresh tests performed by this audit.
- A remote-document skill fetch failed in the helper transport with BrokenPipe; local tracked docs at the exact verified main commit and successful GitHub API metadata were used instead. GitHub jobs endpoint initially returned502; retry fetched complete release-job evidence. These observation errors were not treated as product defects.

## What remains to execute later

- Current Pi read-only identity, health and counters when SSH is available; no service changes are needed for inspection.
- Current native installers on Windows/macOSARM and an interactive MacIntel Keychain session; minimumOS floors and platform credential/ACL behavior.
- Current Linux x64/ARM64 standalone --web with embeddedassets and real systemd service lifecycle in an isolated machine, including reboot persistence.
- Separately authorized physicalradio/third-partyclients: PiRO0084restore afterACK, allTXinitiators and failureboundaries, confirmedRF/unkey behavior, timing and audiblequality. Do not rerun TX helpers without new authorization.
- Long selective media loss and real held-send conditions on isolated networks; sustained adversarial load/soak; actual browser BFCache eligibility/restoration and crash-recovery policy validation.
