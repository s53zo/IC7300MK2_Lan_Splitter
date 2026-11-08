# Standalone executable releases

Download an archive for your computer from [GitHub Releases](https://github.com/s53zo/IC7300MK2_Lan_Splitter/releases).
These executables include Node.js; no separate Node.js installation or `npm install`
is needed. Draft releases are visible only to repository collaborators. Preview
drafts are test builds from a specific commit, not published stable versions.

## Desktop installers and Linux terminal interface

For normal Windows/Mac use, download **`…-win32-x64-Setup.exe`**,
**`…-darwin-x64.dmg`** (Intel Mac), or **`…-darwin-arm64.dmg`** (Apple Silicon).
These include the graphical application and runtime. Follow the
[installation and interface guide](interfaces.md); no terminal setup is needed.
Windows adds a Start menu shortcut, and the Mac disk image provides a drag-to-
Applications shortcut. Linux `.tar.gz` executables open the keyboard interface
when launched interactively; `--tui` selects it explicitly.

Desktop uses pinned Electron 45.2.3 and electron-builder 26.18.0. Windows x64
requires a vendor-supported Windows 10/Server 2016 or newer; Mac builds declare
macOS 13.5 minimum. Native runners validate current OS versions, not every older
supported release. Password protection uses DPAPI/Keychain-backed encryption on
desktop; Linux TUI stores a separate owner-only, unencrypted file. Screens and
reports describe the actual mechanism rather than promising universal encryption.

The release workflow installs the real Windows installer and launches that app;
on each Mac it mounts the DMG, copies and verifies the app, and launches it.
Packaged GUI tests exercise real native credential storage and synthetic LAN
sessions and capture screenshots. Native Linux PTY tests check the keyboard
interface and terminal restoration. All network fixtures use loopback; the live
radio and installed production service are not involved.

Every installer, archive and source download is listed in `SHA256SUMS`. Desktop
applications contain app and transport licenses plus complete Electron/Chromium
notices (including embedded Node notices). The source archive contains the exact
build scripts, lockfile and workflow. The separate headless bundles below use
Node SEA and include `NODE-LICENSE`.

## Optional headless archives

Archive names follow `icom-lan-splitter-<version>-<platform>-<arch>`:

| Computer | Platform and architecture | Archive | Runtime requirements |
| --- | --- | --- | --- |
| Windows PC | `win32-x64` | `.zip` | x64 Windows 10 / Server 2016 or newer; use a vendor-supported OS |
| Intel Mac | `darwin-x64` | `.tar.gz` | macOS 13.5 or newer |
| Apple Silicon Mac | `darwin-arm64` | `.tar.gz` | macOS 13.5 or newer |
| Intel/AMD Linux | `linux-x64` | `.tar.gz` | kernel 4.18+, glibc 2.28+, libstdc++ providing `GLIBCXX_3.4.25`, libatomic |
| ARM64 Linux | `linux-arm64` | `.tar.gz` | same Linux libraries; 64-bit ARM OS and userspace |

Linux downloads target glibc, not Alpine/musl, and are not fully static binaries.
Install the distribution's `libatomic` or `libatomic1` runtime package if missing.
No Windows ARM64, 32-bit ARM or universal macOS executable is built. The OS floors
come from the [pinned Node.js 26.13.0 platform requirements](https://github.com/nodejs/node/blob/v26.13.0/BUILDING.md#platform-list),
not tests on every older OS. GitHub Actions tests the packaged program on its
selected current runners. Node's SEA documentation still excludes macOS Intel
from its upstream SEA test matrix; this project therefore requires its own
native Intel Mac executable smoke test before a release can be prepared.

Each archive includes the executable, platform instructions, application license
and attribution, the Icom transport's third-party license, and the Node.js runtime
license with its bundled third-party notices. Retain these files when redistributing.
The application is AGPL-3.0-only; its corresponding source and build scripts are
in this repository at the commit identified by the release.

## Verify and run

Download `SHA256SUMS` from the same release and compare your archive's SHA-256
before extraction. A matching checksum detects a changed download; it is not a
publisher signature.

Linux:

```sh
sha256sum --check --ignore-missing SHA256SUMS
```

macOS (compare the printed hash with the archive's line in `SHA256SUMS`):

```sh
shasum -a 256 icom-lan-splitter-<version>-darwin-arm64.tar.gz
```

Windows PowerShell (compare the printed hash with `SHA256SUMS`):

```powershell
Get-FileHash .\icom-lan-splitter-<version>-win32-x64.zip -Algorithm SHA256
```

Extract the archive into a versioned directory. On Linux/macOS, run
`./icom-lan-splitter --help`; on Windows, run `.\icom-lan-splitter.exe --help`
from PowerShell. This is a foreground command-line service, not a desktop UI.

The macOS executable has an ad-hoc signature needed for execution. It has no
Apple Developer ID signature and is not notarized. macOS may block a downloaded
copy; after verifying the source and checksum, use the per-app approval described
in [Apple's Gatekeeper instructions](https://support.apple.com/en-us/102445).
Do not disable Gatekeeper globally. The Windows executable is not Authenticode
signed; [SmartScreen](https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/)
may warn about its publisher or download reputation. Managed computers may require
an administrator's approval.

Create a password file outside the extracted directory with a text editor.
It contains only the radio password, optionally followed by one newline. On
Linux/macOS use `chmod 600`; on Windows restrict its ACL to the service account.
Use the same environment configuration as the source CLI. For example:

```sh
export ICOM_RADIO_HOST=192.168.1.50
export ICOM_USERNAME=your-radio-user
export ICOM_PASSWORD_FILE="$HOME/.config/icom-splitter/password"
export ICOM_BIND_ADDRESS=192.168.1.20
./icom-lan-splitter
```

Windows PowerShell:

```powershell
$env:ICOM_RADIO_HOST = '192.168.1.50'
$env:ICOM_USERNAME = 'your-radio-user'
$env:ICOM_PASSWORD_FILE = "$env:USERPROFILE\.config\icom-splitter\password"
$env:ICOM_BIND_ADDRESS = '192.168.1.20'
.\icom-lan-splitter.exe
```

Replace addresses with your radio and this computer's LAN IPv4 address. Configure
clients to connect to the splitter with the radio credentials and codec 4,
48 kHz mono LPCM16. Allow inbound UDP ports 50001–50003 from the local network.
Without `ICOM_BIND_ADDRESS`, only local clients can connect. Stop with Ctrl+C;
normal shutdown attempts confirmed TX release. All cache and safety settings are
unchanged; see [operations](operations.md) for the full configuration and service
examples. Adapt a service's executable path to the extracted standalone binary.
Keep secrets out of command arguments, release archives and source control.

## Prepare a release

The [release workflow](../.github/workflows/release.yml) builds five native standalone targets and three native desktop installers.
Linux ARM64 uses a native ARM runner, and Intel/Apple Silicon macOS use separate
runners. Runner availability and architecture labels are documented by
[GitHub](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
The workflow runs lint, syntax checks, the full test suite and packaged executable
smoke tests against synthetic radio fixtures on loopback. It never requires the
physical radio or deployment host. Smoke tests verify CLI help, password-file
configuration, private replies for two native clients and media forwarding;
they do not validate RF, audible playback or every external client application.

For a preview, run **Actions → Release → Run workflow** on the intended commit or
branch. The workflow prepares a prerelease draft with archive version
`<package.version>-preview.<commit12>`. The draft uses `preview-<commit12>` as its
release tag field without creating a Git tag. Review the workflow result, all five
archives, checksums and source commit before any manual publication.

For a versioned release, update `package.json` and the lockfile consistently,
commit and validate the change, then push an explicitly chosen `v<package.version>`
tag. A mismatching tag fails validation. Tag builds also prepare drafts; they do
not automatically publish. Publishing requires a separate maintainer action.
Never move an existing published version tag or replace its binaries silently.

To reproduce a native build, install the exact Node.js version pinned by the
release scripts (26.13.0) from the official Node.js distribution, check out the
release commit, and run:

```sh
npm ci
npm run release:build
npm run release:smoke -- --executable <path-to-built-executable>
```

Some distributor builds (including Homebrew) disable SEA; use the official
Node.js executable, as the workflow does. Outputs are in `dist/`. Builds use Node's built-in `--build-sea`, with no external
packager dependency. The pinned runtime, source inputs and build process make the
build repeatable; independently generated platform signatures and executable
metadata may prevent byte-identical archives. Verify downloaded release artifacts
against that release's recorded checksums rather than a local rebuild's hash.
See the [pinned SEA documentation](https://github.com/nodejs/node/blob/v26.13.0/doc/api/single-executable-applications.md)
for runtime embedding and platform limitations.

## Upgrade and rollback

Keep the previous extracted version and external password/configuration files.
During receive, stop the running service normally, change its executable path to
the new version, and start it. Verify the radio connection and downstream clients.
To roll back, stop normally, restore the old executable path and start again with
the same configuration. Clients may reconnect during either change. Do not run
both versions against the radio simultaneously; the radio accepts one LAN session.

## Build and test the desktop installers

Use a native Windows x64, Intel Mac or Apple Silicon Mac with the workflow's
pinned Node 26.13.0. From the exact source commit:

```sh
npm ci
npm run desktop:install
npm run desktop:start
```

The explicit install step downloads the pinned official Electron runtime; it is
not an end-user requirement. To build and test the real installer/disk image:

```sh
npm run desktop:build
npm run desktop:smoke
```

The smoke installs/copies the actual distributable into a temporary directory and
uses loopback fixtures plus native credential encryption. Screenshots and its
result are written beneath `.release/screenshots/`. It never uses a physical
radio. Linux native release jobs also run the default no-argument TUI in a real
PTY with two synthetic clients and test confirmed shutdown. There are no cloud
or remote-control dependencies in the installed interfaces.
