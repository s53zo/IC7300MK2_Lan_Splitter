# Linux headless web service

This optional mode is for Linux headless computers, including Raspberry Pi.
Windows/Mac desktop applications and the interactive Linux terminal interface
keep their existing behavior. The Linux system service owns the splitter; a
browser is only a management client. Closing a browser or signing out does not
stop the radio connection. Stop/Start in the dashboard controls the radio while
the web interface remains available.

## Open the interface

On the configured local network address, open **`https://<Pi-address>:50004`**.
Port 50004 is one above the default native UDP ports 50001–50003. It is HTTPS over
TCP; radio clients still use the original UDP ports, not the management port.

A private local HTTPS certificate is generated on first startup. The first visit
requires the browser's per-site certificate approval. A configured trusted local
certificate can be used instead. Do not disable browser certificate checking
globally. Passwords and settings travel over HTTPS; there is no production HTTP
fallback. Access is intended for the local network, not direct public Internet
exposure.

Sign in with the **saved radio username and password**. Existing service settings
are imported privately on first web-mode setup. If no credentials exist yet, use
username **setup** and the private `web-setup-token` file in the configuration
directory; startup prints its path, never its value. After saving valid radio
credentials, those credentials become the login. Changing them retains the
current browser session but invalidates other sessions using the old identity.

## Features

The same Dashboard, Clients, Cache, Settings and Diagnostics views as the desktop
app show the locally running service. This includes all 89 configuration fields,
per-command lifetimes, live client/cache statistics, measured heartbeat ping,
radio response and queue delay, active versus saved settings, and session-only
15-minute history. History belongs to the service process, not a browser tab;
restarting the service resets it.

Save does not interrupt the active connection. Apply & reconnect asks first;
active or pending transmission keeps the existing confirmation and release
behavior. A browser password-file import reads the chosen file on the browser
computer; arbitrary server file paths are not accepted. Export report downloads
a redacted JSON file to that browser rather than writing an arbitrary server
path. Radio tuning/transmit controls remain in existing radio clients.

Settings persist as owner-only `settings.json` plus a separate owner-only,
unencrypted `credentials` file. HTTPS protects network traffic; filesystem
permissions protect these Linux files at rest. The generated certificate/key
live under `tls/`, with private permissions. Normal restarts reuse the certificate;
startup renews an expiring local certificate, which may require browser approval
again. Bootstrap tokens and web session cookies never enter diagnostics.

## Reset statistics

Open **Cache → Reset statistics** and confirm to start a new measurement window.
This clears request/cache/telemetry counters, transport error counters, timing
summaries and graphs. Settings, connections, TX ownership, cached values and
sampling schedules stay active. Live gauges such as client count, queue depth,
ping, sample age and service uptime remain real measurements. New traffic starts
incrementing counters immediately. Diagnostic events remain available.

Requests already admitted before reset finish normally without contributing to
new logical request totals. Physical reads dispatched after reset still count;
received telemetry samples and errors are counted when they occur. Reconnecting
does not restore counters from before the reset.

## Service setup

Use [the systemd example](services/icom-lan-splitter-web.service), adapting the
service account and Node path. Install OpenSSL for local certificate generation.
The existing protected EnvironmentFile supplies initial radio settings and
`ICOM_PASSWORD_FILE`; never put passwords in command arguments. After a valid
saved profile exists, browser-saved radio settings take precedence over the old
environment defaults. The EnvironmentFile can remain as a protected bootstrap
backup. Management listener/TLS settings remain service environment settings.

- `ICOM_CONFIG_DIR`: persistent directory; example `/var/lib/icom-splitter`.
- `ICOM_WEB_BIND_ADDRESS`: local IPv4 interface; use the Pi's LAN address.
- `ICOM_WEB_PORT`: HTTPS TCP port. Default is one above the configured native
  ports; set it explicitly to keep the URL stable after changing radio ports.
- `ICOM_WEB_TLS_CERT` and `ICOM_WEB_TLS_KEY`: optional certificate/key pair. Both
  must be present and valid; no insecure fallback is used if they are invalid.

The unit uses `StateDirectory=icom-splitter`, mode 0700, boot enablement,
network-online ordering, and restart on failure. Keep the persistent directory
writable for its account when hardening the unit. To run from a source checkout:

```sh
node src/cli.js --web --config-dir /path/to/private-state
```

New Linux standalone builds embed the web assets and accept the same `--web`
mode. Earlier v0.8.1 downloads do not contain this subsequently added mode.
The management server starts before attempting the radio, so an unreachable
radio can still be configured through the browser. Process shutdown attempts
normal TX release. Local duplicate-instance protection still applies.
