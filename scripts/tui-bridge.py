#!/usr/bin/env python3
"""Forward pipes to a real PTY for the synthetic packaged-TUI integration test."""
import argparse
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command
    if command and command[0] == '--':
        command = command[1:]
    if not command:
        raise SystemExit('Pass the executable after --')
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    original = termios.tcgetattr(slave)
    child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave,
                             start_new_session=True, close_fds=True)
    stopping = False

    def stop(_number, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    input_open = True
    deadline = None
    try:
        while True:
            if stopping and child.poll() is None and deadline is None:
                child.terminate()
                deadline = time.monotonic() + 10
            if deadline is not None and time.monotonic() >= deadline and child.poll() is None:
                child.kill()
            watched = [master] + ([sys.stdin.fileno()] if input_open and child.poll() is None else [])
            ready, _, _ = select.select(watched, [], [], 0.1)
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b''
                if data:
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
            if sys.stdin.fileno() in ready:
                data = os.read(sys.stdin.fileno(), 4096)
                if data:
                    os.write(master, data)
                else:
                    input_open = False
                    stopping = True
            if child.poll() is not None:
                # Drain any final terminal-restoration sequence before exit.
                while select.select([master], [], [], 0)[0]:
                    try:
                        data = os.read(master, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        break
                    if not data:
                        break
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                restored = termios.tcgetattr(slave) == original
                if not restored:
                    sys.stderr.write('PTY terminal flags were not restored\n')
                    return 2
                return child.returncode
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
    raise SystemExit(main())
