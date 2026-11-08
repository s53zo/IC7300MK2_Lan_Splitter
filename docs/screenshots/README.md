# Interface previews

These screenshots show the native macOS Intel desktop app with loopback synthetic
radio fixtures. The displayed radio address, clients and timings are test data,
not a live-radio status report. Captures cover setup, dashboard, narrow layout and
TX-close confirmation. Release CI also captures every screen on native Windows,
Intel Mac and Apple Silicon Mac, including errors and advanced configuration.

- [Setup](setup.png)
- [Dashboard](dashboard.png)
- [Narrow window](narrow.png)
- [TX confirmation](tx-confirmation.png)

[Per-command cache settings](per-command-cache.png) shows the optional overrides
added in v0.8.1. Blank fields inherit their family default; saved overrides wait
for reconnect before changing the active connection.

The Linux headless mode reuses these views in an ordinary HTTPS browser:
[login](linux-web-login.png) and [service dashboard](linux-web-dashboard.png).
These also use loopback fixtures; closing the browser leaves the service running.
