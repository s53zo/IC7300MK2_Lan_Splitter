# Operation

## Before connecting

Enable Network Control on the radio. Confirm its IPv4 address, the three UDP
ports, and a valid registered network user. Stop other direct remote sessions
before starting the splitter; all clients should subsequently connect through it.
Set LAN modulation input and the required LAN AF/IF output in the radio or client.
The splitter relays client controls and does not automatically choose radio audio
routing or change mode.

The default listen interface is loopback. Bind to the computer's LAN interface
for other hosts, and allow only the local network through the host firewall.
Do not forward these ports from the Internet: native Icom credentials are
obfuscated on the wire, not protected by transport encryption.

## Configuration

All settings are environment variables. `node src/cli.js --help` prints the CLI
reference. There are no password command-line options.

| Variable | Meaning | Default |
| --- | --- | --- |
| `ICOM_RADIO_HOST` | Upstream radio IPv4 address | required |
| `ICOM_USERNAME` | Radio user, also accepted downstream | required |
| `ICOM_PASSWORD_FILE` | UTF-8 password file outside source control | required unless environment password supplied |
| `ICOM_PASSWORD` | Alternative runtime password | unset |
| `ICOM_BIND_ADDRESS` | Downstream listen interface | `127.0.0.1` |
| `ICOM_RADIO_CONTROL_PORT` | Upstream control UDP port | `50001` |
| `ICOM_RADIO_CIV_PORT` | Upstream CI-V UDP port | `50002` |
| `ICOM_RADIO_AUDIO_PORT` | Upstream audio UDP port | `50003` |
| `ICOM_LISTEN_CONTROL_PORT` | Downstream control UDP port | `50001` |
| `ICOM_LISTEN_CIV_PORT` | Downstream CI-V UDP port | `50002` |
| `ICOM_LISTEN_AUDIO_PORT` | Downstream audio UDP port | `50003` |
| `ICOM_CLIENT_TIMEOUT_MS` | Per-client stream heartbeat timeout | `15000` |
| `ICOM_RADIO_TIMEOUT_MS` | Upstream stream heartbeat timeout | `15000` |
| `ICOM_COMMAND_TIMEOUT_MS` | Serialized CI-V reply timeout | `2000` |
| `ICOM_CACHE_ENABLED` | Client read cache and coalescing, strictly `0` or `1` | `1` |
| `ICOM_CACHE_METERS_MS` | Meter/ADC overflow TTL, integer 0–1000 ms | `100` |
| `ICOM_CACHE_STATE_MS` | RX/TX and tuner TTL, integer 0–1000 ms | `100` |
| `ICOM_CACHE_SETTINGS_MS` | Allowlisted public operator settings TTL, integer 0–1000 ms | `250` |
| `ICOM_CACHE_TUNING_MS` | Frequency/mode/VFO TTL, integer 0–1000 ms | `50` |
| `ICOM_MEMORY_BUDGET_MB` | Server replay/reorder/send memory budget, 8–65536 MiB | `128` |

Specify either `ICOM_PASSWORD_FILE` or `ICOM_PASSWORD`, not both. Password files
may have one terminal LF or CRLF; spaces within the password are significant.
Radio passwords must contain 8–16 printable ASCII characters. Username length is
1–16 printable ASCII characters. The service rejects overlapping local
upstream/listener endpoints to avoid a relay loop.

The JavaScript API also accepts explicit server replay limits and broker
queue limits. The CLI memory budget can be raised with `ICOM_MEMORY_BUDGET_MB`. See constructor options in `src/server.js` and `src/broker.js`.
The initial defaults reserve a worst-case amount per session within a 128-MiB
server buffer budget, with 256-packet replay/reorder windows, a 256-KiB pending
send budget per stream, 1,024 queued commands globally and 64 per client. The
128-MiB budget admits roughly 18 clients under the conservative worst-case
reservation calculation; increase it for a larger deployment. These
are configurable resource bounds, not a promise that all admitted clients can
be sustained on every machine. Admission and fanout must be measured for the
intended workload.

## Client read cache

The defaults below limit how long a validated radio reply may serve a later
client read. Only explicitly allowlisted queries qualify.

| Query family | Effective default TTL |
| --- | --- |
| Meters and ADC overflow | 100 ms |
| RX/TX and tuner state | 100 ms |
| Public operator settings | 250 ms |
| Frequency, mode and VFO | 50 ms |

A family TTL of `0` disables caching and coalescing for that family.
`ICOM_CACHE_ENABLED=0` disables all caching and coalescing, restoring one radio
transaction per client read. Reads retain FIFO ordering and never pass queued
writes. Mutations, generation/reconnect changes and unsolicited state
notifications invalidate cached data; scope sample traffic does not. Internal
polls and TX safety checks always read the radio afresh. Stable internal polls
may populate the client cache; startup/release checks neither consume nor
populate it. This reduces repeated CI-V reads; it does not change audio handling
or guarantee that audio dropouts will disappear.

On Linux/macOS, `SIGUSR2` writes one JSON status line to stdout containing radio
state, broker queue/pending/TX ownership booleans and cache counters, including
per-query counters. It excludes credentials, client identities and session
nonces. For systemd:

```sh
sudo systemctl kill --kill-whom=main --signal=SIGUSR2 icom-lan-splitter
journalctl -u icom-lan-splitter -n 20 --no-pager
```

The signal handler is unavailable on Windows. Status counters describe this
process lifetime and do not prove audio quality or physical RF state.

## Install as a service

Use an account that can read only its own password file. Keep the repository or
installed package at a stable path. Templates use placeholder paths, username and
LAN addresses; edit them before use. Secrets belong in the referenced file, not
in the service definition.

### Linux/systemd

Copy [icom-lan-splitter.service](services/icom-lan-splitter.service) to
`/etc/systemd/system/`, adjust the Node path, working directory, user and
configuration, then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now icom-lan-splitter
sudo systemctl status icom-lan-splitter
journalctl -u icom-lan-splitter -f
sudo systemctl stop icom-lan-splitter
```

systemd normally sends SIGTERM, allowing graceful release. Its stop timeout is a
last resort, not proof of radio unkeying if the link is broken.

### macOS/launchd

Edit [local.icom-lan-splitter.plist](services/local.icom-lan-splitter.plist), then
install it at `~/Library/LaunchAgents/local.icom-lan-splitter.plist`:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.icom-lan-splitter.plist
launchctl print gui/$(id -u)/local.icom-lan-splitter
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/local.icom-lan-splitter.plist
```

A LaunchAgent starts in the user's login session. Use the absolute Node path
reported by `command -v node`; a shell's version-manager setup is not loaded.
The template writes diagnostics to local log files.

### Windows/Task Scheduler

Edit [Start-Splitter.ps1](services/Start-Splitter.ps1). First run it in a
PowerShell terminal and verify startup and Ctrl+C shutdown. In Task Scheduler,
create a task for the intended user with an action:

```text
Program: powershell.exe
Arguments: -NoProfile -File "C:\icom-splitter\docs\services\Start-Splitter.ps1"
Start in: C:\icom-splitter
```

Choose a logon/startup trigger suitable for the account and allow the three UDP
ports through Windows Firewall for the Private profile. Set the task to avoid
starting a second instance. Protect the password file with that account's ACL.
Task Scheduler's **End** action may forcibly terminate the process and cannot be
relied on for graceful TX release. Stop clients' TX first, verify receive on the
radio, then stop the task. Foreground Ctrl+C is the supported interactive graceful
stop path on Windows. A native Windows service wrapper is not bundled.

## TX handover timing

PTT stop/disconnect begins explicit cleanup immediately. CW text is buffered in
the radio and receive gaps do not prove its text queue is empty. Automatic CW
handover therefore uses a conservative 6 seconds per input character (derived
from 6 WPM and 22 Morse time units), followed by three observed receive polls.
This may hold ownership longer than actual keying. An explicit owner stop avoids
that automatic-completion wait.

Voice-memory playback can repeat after long silent intervals. Its lease remains
owned until explicit stop or disconnect; silence alone does not release it.
Tuner ownership also uses its status and a specific tuner-stop cleanup command.
Lease boundaries discard buffered client CI-V/audio, retire the highest observed
sequence number, and invalidate upstream replayable TX data. A native Icom packet
has no TX-epoch field: a never-before-seen packet delayed in the network cannot
always be distinguished from a current packet within the same association.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Other computers cannot connect | Bind address is a LAN interface, not loopback; client ports and host firewall permit UDP |
| Radio stays disconnected | Network Control, radio address/ports, credentials, and availability of the one direct radio session |
| Login succeeds but media fails | Client requested source ports must remain stable; avoid NAT; use codec 4/mono/48 kHz |
| Audio received but no TX modulation | Radio's LAN MOD input and level, selected data/voice modulation route, and client TX ownership |
| No waterfall | Radio supplies scope frames and the client accepts broadcast CI-V scope; the splitter enables shared scope output and prevents client OFF commands from disabling it globally |
| A change returns NG during TX | Another client owns TX; rejected changes are deliberately discarded |
| Reconnect after a command timeout | A reply could not be attributed safely; the session reset prevents late ACKs confirming later commands |
| Client admission stops | Inspect configured memory budget and host resources; measure with the capacity tool |
| TX does not end after a failure | Check radio-side timeout and physical keying; no process can deliver PTT-off over a lost link |

Do not enable packet dumps in normal operation. Login and token packets contain
reversible credentials/session material. Share redacted state transitions and
version information when reporting a fault.
