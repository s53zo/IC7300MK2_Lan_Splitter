# Approved audit follow-up

User instruction: "Do as recommended" (2026-11-08).
Keep client TTLs100ms meters/state,250ms settings,50ms tuning and all audio handling unchanged. No RF tests. Stage versioned releases and activate only during receive, retaining rollback.

1. Correctness: guard asynchronous safety polling with owner/trigger incarnation and acknowledged start/grace checks; add exact bare10/11/12 getters and correct fixed-prefix RX-antenna replies; enforce0.5dB reference steps. Lock repros with regressions first.
2. Availability/measurement: absolute preauth expiry and bounded eviction separate from authenticated reservation; preserve many clients sharing one IP. Add bounded reason codes, logical/physical counts, outcome conservation, timing buckets including350ms and aggregate client/session status. Never expose credentials, tokens, endpoints or reply values.
3. Validate full test suite, native-client smoke, ARM64 subset and six-job CI. Deploy and sample real request/caching counters.
4. Evaluate genuine write-overlap misses after getter correction. Adopt pre-write queued-result tokens only if measured useful and adversarial lifecycle/priority/expiry tests preserve barriers. Otherwise document why deferred; do not add complexity merely for a synthetic win.

Parallel ownership: safety lane src/broker.js poll/lease fields and tests/safety-poll.test.js only, then parent owns broker telemetry; policy lane src/read-cache.js,tests/read-cache.test.js,tests/fixtures/icom-radio.js; admission lane src/server.js,tests/server.test.js; parent telemetry module/tests,CLI/config/docs/deployment. All lanes must accommodate shared changes without reverting others.
