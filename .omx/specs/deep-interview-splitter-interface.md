# Local splitter interfaces — first-version requirements

Status: User choices captured in nine rounds. Implementation subsequently authorized by the attached active goal; see ../plans/local-interfaces-plan.md. The original interview did not itself authorize implementation.
Profile: standard. Residual ambiguity estimate ~15% (subjective scope assessment, not measured certainty). No blocking product choice remains; technology and detailed visuals require architecture/design work.
Context snapshot: .omx/context/splitter-interface-20261108T152200Z.md

## Intent
Make installation, configuration and monitoring accessible without terminals, environment-variable commands or manually authored launch scripts on Windows/macOS. Provide a keyboard-operated interface for Linux.

## Confirmed behavior
1. Interfaces manage the local splitter only. No remote service management.
2. The interface owns the running service. Closing the interface stops the local splitter and disconnects downstream clients; no hidden background service or tray-only lifecycle.
3. First launch presents setup. Subsequent launches automatically start/connect using saved settings.
4. Closing during RX stops normally without confirmation. Closing during active TX asks confirmation before attempting TX release and normal shutdown. Cancel leaves the interface and service running. Existing fail-safe release behavior must be preserved; never claim release succeeded without radio confirmation.
5. Save edited configuration without disrupting the active connection. Clearly distinguish saved/pending configuration from active configuration. Apply changes requiring reconnect only after user confirmation; do not silently reconnect. Never auto-apply them during TX.
6. Remember the radio password locally. Mask it in Settings and omit it from diagnostics. The concrete credential-storage mechanism is a technical design decision; avoid claiming encryption or OS credential-vault support until implemented and verified.
7. Setup and monitoring only. Frequency, mode and transmission operation remain with existing radio clients.
8. Statistics live in memory during this app session. History graphs cover the last 15 minutes. Closing resets statistics history; saved settings remain.
9. Windows installer (Setup.exe), Start menu shortcut, graphical app; macOS DMG with a proper application dragged into Applications; Linux standalone executable opening a terminal interface. No end-user Node.js install. Install/start/configure on Windows/macOS must work without terminal commands.

## Proposed information architecture
- Dashboard: clear connection state and understandable errors, RX/TX, uptime, connected clients, rates, cache savings, ping, response/queue delays, short history graphs, Start/Stop/Reconnect.
- Clients: per-client identity/name where available, address, connection duration and media/data activity. Client controls beyond observation are not part of the agreed first version.
- Cache: eligible requests/hits/misses, hit percentage with labelled denominator, avoided radio reads, physical radio transactions, coalescing as a subset of hits, per-query breakdown and TTL values.
- Settings: basic radio address/username/password/local network selection, advanced network/timeout/resource/cache settings, explanations and units, Save, Test Connection and Restore Defaults. Include every existing public configuration parameter; never require environment editing for GUI use.
- Diagnostics: bounded recent events, readable fault/reconnect messages and exportable redacted diagnostic report. No packet payloads or credentials. This is a proposed screen organization derived from the requested scope, not a user-approved visual design.

## Metrics semantics
Clearly distinguish native LAN ping round-trip time, physical radio transaction response time, and broker queue wait. Show metrics only when genuinely measured, with unavailable/stale states rather than fabricated zeros. Explain units, time window and denominators in accessible labels.
Expose connection/cache statistics, native client count, delays and ping milliseconds as explicitly requested. Show transport loss/late/stream interruption health where instrumentable; do not claim end-to-end audible audio latency or playback quality from gateway counters.
Retain logical/physical request conservation and bounded telemetry. The monitoring path must not create a second upstream radio session, flood radio reads or interfere with safety polling.

## Configuration inventory grounded in src/config.js and src/cli.js
- Radio IPv4, username and password/password-file import semantics.
- Local binding/interface and local control, CI-V and audio UDP ports.
- Radio control, CI-V and audio UDP ports.
- Authenticated memory budget, pending-login memory budget and absolute pending-login deadline.
- Client heartbeat, radio heartbeat and CI-V command timeouts.
- Cache enabled and independent meter/ADC, state/tuner, settings and tuning/VFO TTLs.
Choose normal platform configuration locations and versioned schema during design; migrate safely and never store secrets in distributable examples. Existing headless CLI/env operation should remain compatible; the GUI/TUI's close-stops behavior applies to the service it owns, not unrelated running deployments.

## Non-goals and constraints
No remote administration, radio front-panel replacement, persisted metrics history, cloud dependency, hidden service after closing, or changes to native LAN protocol/cache/audio/TX semantics. Do not alter the live .82 deployment during development or use physical RF tests for UI validation. No GUI framework choice has been made. Signed/notarized distribution is not promised without available credentials and actual verification; unsigned-platform installation friction must be evaluated in the packaging design.

## Pressure pass
Revisited the initial close-stops-service choice for active transmission. User explicitly chose confirmation during TX, immediate normal close during RX. Revisited automatic connection against password persistence: user chose remembered password and automatic connection. Revisited settings persistence against connection disruption: save without reconnect; confirm before applying reconnect.

## Decision boundaries
User chose the product lifecycle and scope above. Routine implementation/design tradeoffs may be proposed using the existing workspace autonomy authority. This artifact records requirements; the subsequent active goal authorizes implementation and draft release preparation, while live deployment and public release publication remain outside scope. Do not change the confirmed behavior silently. New material product choices should return to discussion.

## Acceptance criteria
- Fresh Windows/macOS installation can be configured, saved, connected, monitored and stopped using graphical controls only; Linux equivalent works through keyboard-operated TUI.
- Every existing public configuration setting is visible/editable with validation; invalid input cannot disrupt a running connection.
- Reopening loads saved settings/password and connects automatically; first-run setup appears only when needed.
- Pending settings and active settings remain distinct; canceling reconnect preserves the current connection.
- Closing RX stops the owned service. Closing TX requires confirmation; cancel preserves operation and confirm enters the existing release/shutdown path. Closing with a pending/in-progress TX request cannot bypass ownership safety checks.
- Two or more synthetic clients appear in stats; private routing, shared media and single upstream association remain correct.
- Displayed request, cache and timing metrics reconcile with controlled synthetic traffic; unavailable measurements are clearly marked.
- Graph retention is capped at 15 minutes and memory bounded; restarting clears history but preserves config.
- Password never appears in exported diagnostics, packaged examples, logs or telemetry.
- Native Windows/macOS installers/apps and Linux TUI artifacts pass automated native-platform tests; preserve current release checks and licensing/source obligations.

## Evidence and assumptions
Existing runtime is Node built-ins, env-configured CLI with password-file support, no GUI or remote management API. Status snapshots already include bounded cache/request timing, client counts and transport counters. Native ping messages exist but reported ping RTT still requires instrumentation. Current native standalone releases use Node SEA on five targets. Desktop framework, installer tools, terminal toolkit, credential backend, update UX and full signing/notarization strategy are not selected. Diagnostics export, detailed client table and exact screen organization are proposed design details, not separate explicit user choices.
