# Plan: local desktop and terminal interfaces

## Binding scope and architecture
The attached implementation goal supersedes the earlier interview's discussion-only gate. See .omx/specs/deep-interview-splitter-interface.md and interview transcript. Local-only owned lifecycle, saved settings, confirmed TX closure/reconnect, session-only 15-minute history. No physical radio or .82 deployment changes.

Shared src/app controller owns one Splitter in process, validated public settings schema, separate credential adapter, OS-owned instance/radio locks and bounded safe snapshots. Desktop uses Electron45.2.3 (official darwin-x64 and arm64 supported), sandboxed local renderer, explicit IPC allowlist and OS-backed safeStorage; electron-builder26.18.0 supplies NSIS and DMG packaging. Linux TUI uses Node built-ins/ANSI/readline and the same controller, packed with Node SEA26.13.0. Existing CLI remains available; duplicate radio locks are shared. No browser-only substitute or external management API.

## Phase1 — Core and observational telemetry
- Core lane: src/app/settings,store,lock,controller plus app regression tests. Every public env setting represented, blank password retains previous, import-file semantics, protected atomic writes, explicit active/saved state, cancellable start/stop, TX race gates, autostart, duplicate ownership. Demo synthetic radio with two clients.
- Metrics lane: existing heartbeat RTT only, bounded tracking and stale semantics; retain packet behavior. Test echo correlation and fake clocks.
- Parent integrates CLI radio lock and interactive entry, preserving automation/headless operation.

## Phase2 — Interfaces (parallel after contract)
- Desktop lane: main/preload and renderer five screens, first-run, all fields, reconnect/close dialogs, native credential backend, redacted export, readable narrow layout. Native smoke captures setup, dashboard, cache, clients, advanced settings, error and narrow screenshots; exercise UI over synthetic fixtures.
- TUI lane: five screens, form editor, masked secrets, actions/dialogs, trends, export, terminal restoration. FakeIO tests plus actual PTY launches validate navigation, save, history and exits.
- Parent validates Electron build and native credentials; read-only independent review covers lifecycle, renderer/IPC and measurement honesty.

## Phase3 — Packaging and CI
- Preserve existing native SEA matrix/headless smoke. Linux interactive SEA starts TUI and supports explicit --tui.
- Three native desktop jobs: Windows x64 installs NSIS in user space then launches installed application; macOS Intel/ARM build DMG, mount and copy app then launch packaged app. Gate draft assembly on all native tests and synthetic protocol smoke.
- Archive/source/LICENSE/NOTICE/runtime license obligations/checksums retained; no local settings or credentials packaged. Desktop output contains Electron/Chromium full notices.
- Native installers and screenshots uploaded as Actions artifacts. Release includes GUI installer/DMGs, Linux executables, optional headless bundles, source and SHA256SUMS.

## Phase4 — Verify and deliver
Lint, syntax/static, full regressions; fakeclock and adversarial pendingTX tests; keyring/DPAPI actual native tests; native settings/save/autostart tests; synthetic client media/private routing tests; actual PTY restoration; inspect desktop screenshots including narrow/errors and iterate; native installer content/launch tests; draft only from final commit. Download all assets and verify SHA256 and embedded source identity, rerun local packaged Mac app. Lore commits and push. Report exact OS coverage/signing limits/links/screenshots.

## Risks and mitigations
- Close/reconnect races: serialize lifecycle and re-check owner, observedTX, queued/pending initiators at execution; freeze new work via existing close/release path, never use stale renderer booleans for safety.
- Desktop secrets: OS-backed encrypted file, no raw password in status, deny unavailable backend rather than silently claim encryption. Linux stores separate0600 file with honest protection label.
- Duplicates: appdir lock plus cross-config radio IPv4 lock via loopback TCP ownership; release only after close. Existing older releases do not participate; listen port conflicts remain fail-closed.
- SEA linker now needs fs/path/os helpers for TUI and core: staticbuiltins only; preserve actual entry semantic and no filesystem source dependency.
- Installer and signing friction: unsigned Windows and ad-hoc macOS; do not claim notarization. Actual new framework OS floors checked against official runtime and native runner tests.
- Native framework versions pinned and current official docs read; app runtime no npm dependencies beyond Electron itself. No unrelated refactor/cleanup.

## Rollback
Keep current published headless prerelease unchanged. New release is an unpublished draft. No live deployment activation. Revert reviewed commits if needed; existing CLI compatibility tests must stay green.
