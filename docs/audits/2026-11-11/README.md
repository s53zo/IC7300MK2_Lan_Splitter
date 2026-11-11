# Full-product SWE audit — 2026-11-11

Audited source: `ec801be1af4f0e05e5b156848541a788d7a704b0`. Audit only: no implementation changes, commits, publishing, deployment or production service operations.

- [Consolidated report](report.md): decisions and confirmed findings.
- [Feature verification matrix](feature-matrix.md): expected behavior, source, checks and limits.
- [Verification and reproduction guide](verification.md): commands, outcomes and expected failing invariants.
- [Prioritized proposed fixes](proposed-fixes.md): changes for the owner's decision; none implemented.
- [Evidence manifest](evidence.json): current source/CI/release identity and bounded check results.
- [Workload results](workload-results.json): bounded active-sampler/media and 128-client loopback measurements.
- [Probe execution results](probe-results.json): syntax and expected exit status for all ten audit scripts.
- [Query inventory](query-inventory.json): all 67 allowlisted getter shapes and declared TTLs.
- [Configuration inventory](configuration-inventory.json): all 90 field definitions; no saved profile or real credential.
- [Independent reviewer reports](reviewers/): lanes A–F, with separate cross-review notes.
- [Reproduction scripts](reproductions/): isolated synthetic/in-memory probes; no physical radio or production addresses.

“Verified” means verified within the stated test/platform scope. A fixture pass is not physical-radio, RF or audible-quality certification. Current Pi state could not be independently read during this audit because SSH banner exchange timed out.
