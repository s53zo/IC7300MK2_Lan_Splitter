#!/usr/bin/env python3
"""Exercise the real packaged terminal UI in an isolated pseudoterminal.

Uses only Python's standard library. Never supplies a real radio endpoint,
starts the splitter, changes HOME, or sends any radio/transmit command.
"""
import argparse
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--executable', help='Native packaged splitter executable')
    group.add_argument('--source', action='store_true', help='Development only: run source CLI with Node')
    args = parser.parse_args()
    if sys.platform == 'win32':
        raise SystemExit('This test needs POSIX pseudoterminals; use the native Linux release jobs.')
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix='icom-tui-smoke-') as directory:
        config = Path(directory) / 'config'
        xdg = Path(directory) / 'xdg'
        env = {k: v for k, v in os.environ.items()
               if not k.upper().startswith('ICOM_') and k.upper() not in ('NODE_OPTIONS', 'NODE_PATH')}
        env.update({'XDG_CONFIG_HOME': str(xdg), 'TERM': 'xterm-256color'})
        command = ([shutil.which('node') or 'node', str(root / 'src' / 'cli.js')]
                   if args.source else [str(Path(args.executable).resolve())])
        command += ['--tui', '--config-dir', str(config)]
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
        before = termios.tcgetattr(slave)
        child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave,
                                 cwd=directory, env=env, start_new_session=True, close_fds=True)
        captured = bytearray()

        def pump(timeout=0.1):
            ready, _, _ = select.select([master], [], [], timeout)
            if not ready:
                return
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    return
                raise
            captured.extend(data)

        def expect(text, start=0, timeout=15):
            needle = text.encode()
            deadline = time.monotonic() + timeout
            while needle not in captured[start:]:
                if child.poll() is not None:
                    raise AssertionError(f'Terminal process exited before {text!r}: code {child.returncode}')
                if time.monotonic() > deadline:
                    # Do not dump screen buffers: this harness verifies secrecy.
                    raise AssertionError(f'Timed out waiting for terminal screen text: {text!r}')
                pump()

        def press(keys, text=None):
            offset = len(captured)
            os.write(master, keys.encode())
            if text:
                expect(text, offset)
            else:
                # Let readline consume individual navigation keys before a
                # subsequent assertion; this does not wait on external state.
                deadline = time.monotonic() + 0.12
                while time.monotonic() < deadline:
                    pump(0.02)
            return offset

        try:
            expect('First launch: enter radio address')
            during = termios.tcgetattr(slave)
            assert not during[3] & termios.ICANON, 'TUI did not enable raw keyboard navigation'
            press('1', 'LIVE PERFORMANCE')
            press('2', 'CONNECTED CLIENTS')
            press('3', 'CACHE — current interface session')
            press('4', 'SETTINGS — saved separately')
            # First field is always radio IPv4; this invalid endpoint cannot
            # result in a hardware connection, even if start were attempted.
            press('\r', 'EDIT Radio address')
            press('999.0.0.1')
            press('\r')
            press('\x1b[B')
            press('\x1b[B')
            press('\r', 'EDIT Radio password')
            secret = 'smoke-pass'
            press(secret)
            press('\r')
            assert secret.encode() not in captured, 'Password appeared in terminal output'
            offset = press('s')
            deadline = time.monotonic() + 5
            while not any(word in captured[offset:].lower() for word in [b'ipv4', b'invalid', b'not saved', b'check the selected']):
                if time.monotonic() >= deadline:
                    raise AssertionError('Invalid settings did not produce a readable validation error')
                pump()
            # No settings or credential should have been persisted from the
            # rejected form. Only controller lock metadata may exist.
            if config.exists():
                for file in config.rglob('*'):
                    if file.is_file():
                        assert secret.encode() not in file.read_bytes(), 'Rejected password persisted to disk'
            press('5', 'DIAGNOSTICS — no passwords')
            press('e', 'Report saved:')
            reports = list(config.glob('diagnostics-*.json'))
            assert len(reports) == 1, 'Diagnostic export missing'
            report = reports[0].read_text()
            assert secret not in report, 'Password leaked into diagnostics'
            json.loads(report)
            assert reports[0].stat().st_mode & 0o777 == 0o600, 'Diagnostic report permissions are not owner-only'
            press('q')
            deadline = time.monotonic() + 15
            while child.poll() is None:
                if time.monotonic() >= deadline:
                    raise AssertionError('Quit did not stop the process')
                pump()
            while select.select([master], [], [], 0)[0]:
                previous = len(captured)
                pump(0)
                if len(captured) == previous:
                    break
            assert child.returncode == 0, f'TUI exited with status {child.returncode}'
            after = termios.tcgetattr(slave)
            assert after == before, 'Terminal flags were not restored'
            assert b'\x1b[?25h\x1b[?1049l' in captured, 'Cursor/alternate screen were not restored'
            assert secret.encode() not in captured, 'Password appeared in terminal output'
            print(json.dumps({'result': 'pass', 'mode': 'source' if args.source else 'packaged',
                              'platform': sys.platform, 'realPty': True, 'views': 5,
                              'passwordMasked': True, 'invalidSettingsRejected': True,
                              'diagnosticExport': True, 'terminalRestored': True,
                              'physicalRadioUsed': False, 'txRequested': False}))
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
            os.close(master)
            os.close(slave)


if __name__ == '__main__':
    main()
