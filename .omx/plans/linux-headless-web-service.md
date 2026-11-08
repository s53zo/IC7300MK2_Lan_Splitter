# Linux headless browser service

User requested install v0.8.1 as boot-persistent service on .82, then explicitly
requested a web interface one port higher, same GUI data/features, Linux headless
only. This supersedes the prior no-remote-management/no-background-interface scope
for this Linux mode. Desktop Windows/Mac and interactive LinuxTUI unchanged.

## Architecture and ownership
- Shared AppController still owns one native radio session; HTTPS host remains
  available while radio stopped/recovering, and browser closure neverstopsservice.
- Backend lane src/web/server.js: bounded authenticated sessions/rate/body limits,
  sameorigin+CSRF+Host guards, strict action and static asset allowlists, no server
  file path import, redacted report export and TX confirmation semantics.
- Frontend lane src/web bridge/loginfiles: reuse desktop rendering through a
  narrow web adapter; session login, polling, browser-local password import,
  downloadable redacted reports, logout and service-session labels.
- Bootstrap lane src/web main/assets/tls: Linux CLI entry, protected saved state,
  seed existing environment only on first setup, HTTPS certificate generation via
  openssl or configuredTLS, firstsetup tokenfile (neverlogvalue), startup/shutdown.
- Parent CLI/build wiring, actual browser+fixture integration, systemd deployment,
  docs and finalverification. Independent security review after serverlands.

## Protocol/lifecycle constraints
No extra radio probes or upstream sessions. Existing safety/cache/audio and
per-command defaults unchanged. Web stop stops radio only; authenticated start
works afterward. OSstop/restart attempts normalconfirmedrelease; no production
TX tests. Keep existing .82 settings/passwords private and preserve rollback.
HTTPS port50004 (one above50001–3), bind.82LANonly for deployment. HTTP TLS local
certificate needs first browser approval; no plaintext credential fallback.

## Verification and delivery
Unit tests authentication/session/CSRF/origin/Host/path traversal/body caps,
TLS/statepermissions/migration/start ordering and Linuxonlyguard. Browser smoke
using existing Electron dev runtime as ordinarysandboxedHTTPSbrowser (nopreload)
against loopback synthetic radio: login, fiveviews,89fields, cachecontrols,
private2clients/media, actualstats, savepending/apply/TXconfirm and browserclose
isolation. No desktopbehaviorchanges. Alltests/lint/syntax plus nativeARM tests
beforeactivation. Deployimmutableversioned source with explicitNode--web unit,
StateDirectory0700, existingprotectedenv/credentials, startupenabled+Restart.
VerifyHTTPSlogin/authAPI/readiness/oneupstream and controlledrestartautostart;
retainpreviousrelease and previousunit forrollback. No restart loops/disruptions
merely for extra proof. Commit and push source; no stableversion/tag/publicrelease
unless separatelyrequested.
