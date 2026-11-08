# Splitter interface requirements intake

Task: Discuss and jointly define a user-friendly Windows/macOS GUI and Linux terminal interface before implementation.
Outcome: Configure and persist every setting, inspect connection/cache statistics, client counts, delays and ping.
Evidence: Existing Node built-ins CLI, env-only config plus external password file; bounded status snapshots via SIGUSR2 include client/session counts, queue, cache and timing histograms. No GUI or network management API yet. Existing Windows/macOS/Linux standalone releases.
Constraints: Preserve radio protocol, TX safety, cache/audio behavior. No implementation until discussion defines scope. Do not store credentials in interview artifacts.
Unknowns: Local versus remote service management; graphical delivery/browser preference; setup/start/background lifecycle; credential storage/config locations; exact latency semantics and client details; Linux TUI behavior; non-goals and decision boundaries.
First question: Should interfaces manage a local splitter, an existing remote splitter, or both?
