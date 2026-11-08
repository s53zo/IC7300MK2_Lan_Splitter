# Install, connect and monitor

The desktop app is the easiest way to run the splitter on Windows or Mac. Linux
has a keyboard-operated terminal interface. Each interface controls the splitter
on **that computer**; it is not a remote control panel for another server.

The interface owns the running splitter. Keep it open while using the radio.
Closing it disconnects clients and stops its radio connection. If transmission
is active or pending, a normal close asks before attempting to release
transmission. Cancel leaves the application and connection running.

## Windows

1. Open the repository's [Releases page](https://github.com/s53zo/IC7300MK2_Lan_Splitter/releases).
2. Under **Assets**, download the file ending in **`win32-x64-Setup.exe`**.
3. Run the installer and follow its steps. It installs for your account and adds
   **Icom LAN Splitter** to the Start menu.
4. Open **Icom LAN Splitter**. On first launch, enter your radio's IPv4 address,
   username and password in **Settings**, then choose **Save & connect**.
5. Wait for **Connected** on the Dashboard. Point your radio clients at this
   computer's LAN address, using the same radio credentials.

No PowerShell commands, launch scripts or Node.js installation are needed.
The Windows installer is unsigned. Windows may display a publisher/reputation
warning, and managed computers may restrict installation. This is not a signed
installer; verify the download's checksum and source before using it.

## Mac

1. Choose the **`darwin-arm64.dmg`** download for an Apple Silicon Mac or
   **`darwin-x64.dmg`** for an Intel Mac. **Apple menu → About This Mac** identifies
   your computer's chip or processor.
2. Open the DMG and drag **Icom LAN Splitter** into **Applications**.
3. Eject the DMG, then open the installed application from Applications.
4. Enter the radio address, username and password, then choose **Save & connect**.

The application is ad-hoc signed, not Apple Developer ID signed or notarized.
macOS may request a per-application approval. After verifying the download,
follow [Apple's instructions for opening an app from an unidentified developer](https://support.apple.com/en-us/102445).
Do not disable Gatekeeper globally. A terminal command is not part of normal
application setup.

The installed application contains its runtime; a separate Node.js installation
is not needed.

## Linux

Download and extract **`linux-x64.tar.gz`** for Intel/AMD Linux or
**`linux-arm64.tar.gz`** for a 64-bit ARM Linux installation. Open a terminal in
the extracted directory and run:

```sh
./icom-lan-splitter
```

An interactive Linux launch opens the terminal interface. The explicit form is
`./icom-lan-splitter --tui`. The existing environment-configured service remains
available through `--headless`; do not use that mode for the interactive setup.

On first launch, Settings opens automatically. Select a field with the arrow
keys and press Enter to edit it. Enter accepts the field; Escape cancels that
edit. Enter the radio address, username and password, save, then press F6 to
start. The password is masked while typing. Later launches automatically connect
using the saved configuration.

| Key | Action |
| --- | --- |
| `1`–`5`, Tab / Shift+Tab | Dashboard, Clients, Cache, Settings, Diagnostics |
| Up / Down, Page Up / Page Down | Scroll; select fields in Settings |
| Enter | Edit/accept a field, toggle an option, or activate a selected button |
| Escape | Cancel a field edit or confirmation |
| Ctrl+U while editing | Clear the current field |
| `S` in Settings | Save settings |
| `D` in Settings | Load defaults into the form; Save is still required |
| F6 | Start |
| F7 | Stop |
| F8 | Reconnect after confirmation |
| `E` in Diagnostics | Save a redacted diagnostic report |
| F10, `Q`, Ctrl+C | Quit; confirm if transmission is active or pending |
| `Y` / Enter; `N` / Escape | Accept; cancel a confirmation |

The terminal must remain open. Normal exit restores its cursor and input mode.
If the terminal is lost or the process receives a termination signal, it attempts
release and shutdown; it cannot ask an interactive question in a lost terminal.
A forced process kill or unreachable radio cannot guarantee physical unkeying.

## Where configuration is saved

Settings are saved automatically when you choose **Save settings**. You do not
need to find or edit a configuration file to use either interface. The settings
file is named **`settings.json`**, with a versioned format. Passwords are stored
separately and are not included in that JSON file.

The shared interface's platform configuration locations are:

| Platform | Directory |
| --- | --- |
| Windows | `%APPDATA%\IC7300MK2 LAN Splitter` |
| Mac | `~/Library/Application Support/IC7300MK2 LAN Splitter` |
| Linux | `$XDG_CONFIG_HOME/icom-lan-splitter`, or `~/.config/icom-lan-splitter` when unset |

The Linux terminal interface accepts `--tui --config-dir DIRECTORY` for an
explicit settings location. An alternate directory starts a separate saved
profile; local instance/radio locks still prevent competing connections.
Keep configuration outside the extracted installation directory so replacing an
application version does not replace its saved settings.

**Password protection:**

- The Windows desktop app uses Electron's OS-backed encryption tied to your
  Windows login (DPAPI). It stores encrypted bytes in `credentials.bin`.
- The Mac desktop app uses Keychain-backed encryption and stores encrypted bytes
  in `credentials.bin`. A locked/unavailable credential store produces an error;
  the desktop app does not silently save a plaintext fallback.
- The Linux terminal interface stores the password in a separate **`credentials`**
  file readable only by its owner (`0600`), inside an owner-only directory
  (`0700`). **This file is not encrypted.** The Settings screen describes this
  protection. Protect your Linux account and backups accordingly.

Changing a password replaces the saved one. Leaving the password field blank
keeps the remembered password. **Import password file** copies the value from an
existing text file; its path is not saved as the application's credential source.
Passwords are excluded from interface snapshots, logs and diagnostic exports.
The legacy headless CLI still supports its existing environment/password-file
configuration independently of this settings format.

## Changing settings without interrupting clients

**Save settings** validates and remembers changes while leaving the active radio
connection alone. A **New settings are saved** banner indicates that saved and
active settings differ. Choose **Apply & reconnect** when ready; it explains the
client interruption and asks before reconnecting. Cancel preserves the current
connection. Transmission requires a further confirmation before release.

**Restore defaults** changes the form only. It does not overwrite saved settings
or reconnect until you save and apply. The Advanced section includes ports,
cache TTLs, heartbeat/command deadlines and client resource budgets. Labels show
units and allowable ranges. Normal first-run setup needs only the radio details
and an appropriate local listen address.

The default listen address `0.0.0.0` accepts clients through this computer's
network interfaces. `127.0.0.1` permits only clients on this computer. Client and
radio UDP ports default to 50001, 50002 and 50003. If the OS asks about network
access, permit the application on your trusted local network.

The radio allows one upstream LAN session. When moving the splitter to another
computer, stop its old instance first. Local duplicate-instance protection cannot
stop a splitter already running on a different computer.

## Reading the dashboard

- **Connected** means the radio transport and the broker's initial safety checks
  are ready. Connecting/recovery states do not mean clients can operate yet.
- **Radio ping** is measured native LAN heartbeat round-trip time. It uses the
  existing heartbeat traffic; opening the Dashboard does not send extra probes.
  A dash or unavailable/stale label means no recent valid measurement exists.
- **Command response** measures the radio transaction from dispatch to matching
  reply. **Queue wait** measures time before dispatch. These are different from
  ping and from client-end network or audio-playback latency.
- **Cache savings** uses eligible reviewed client requests as its denominator.
  A cache hit avoids one otherwise-needed radio query. Coalesced replies are a
  subset of hits, not extra savings. Physical transactions include uncached
  commands and fresh internal safety reads, so their rate has a different
  denominator.
- **Audio transport health** reports packet counters where available. It does
  not prove that every client heard uninterrupted audio.

Statistics cover the current application session, including stop/start or
reconnect operations within that session. Graphs retain at most 15 minutes and
are held in memory. Closing and reopening clears the counters/history but keeps
configuration and the saved password. Nothing continuously writes statistics
history to disk.

## Diagnostics and shutdown

Diagnostics shows recent bounded events and readable connection errors. Choose
**Export report** to save a redacted report on desktop, or press `E` in Linux
Diagnostics. Linux writes the report into the local settings directory and shows
its path. A report contains connection/counter/timing information, not passwords,
credential files or packet contents. Check whether you want to share remaining
operational information before sending it to someone else.

Close during receive stops normally. If transmission is active or pending, the
app asks before releasing it and disconnecting everyone. Cancel keeps running.
If the radio cannot confirm receive state during shutdown, the app reports that
uncertainty; check the radio directly before leaving it unattended. Software
cannot confirm physical RF output or unkey a radio it can no longer reach.

For upgrades, keep the previous installer/application or extracted Linux version
until the new one works. Stop normally, replace the application, and reopen it.
To roll back, stop normally and reinstall/reopen the previous application using
the same saved settings. Never run both versions against the radio together.

See [release downloads and platform requirements](releases.md) for checksums,
OS/library requirements, source archives and the separate headless downloads.
