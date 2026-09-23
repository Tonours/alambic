#!/usr/bin/env python3
"""Checkbox picker under a real pty: Ctrl-C and a throwing draw both restore
the terminal mode, and an aborted setup writes nothing."""
import os
import select
import shutil
import subprocess
import sys
import tempfile
import termios
import time

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')
# Resolve through version-manager shims once, with the real env; the test env is minimal.
NODE = subprocess.run(['node', '-p', 'process.execPath'], capture_output=True, text=True, check=True).stdout.strip()
MODE_FLAGS = termios.ICANON | termios.ECHO | termios.ISIG


def lflags(fd):
    return termios.tcgetattr(fd)[3] & MODE_FLAGS


def run_in_pty(argv, env, keys, wait_for, probe=None):
    """Run argv on a pty, send keys once wait_for shows up. When probe is set,
    record the terminal mode as soon as probe shows up (child still alive:
    libuv resets the tty at exit, which would hide a missing restore), then
    send a newline to let the child exit."""
    master, slave = os.openpty()
    before = lflags(slave)
    proc = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True)
    out = b''
    live = None
    deadline = time.time() + 15
    sent = False
    while time.time() < deadline:
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                out += os.read(master, 4096)
            except OSError:
                break
        if not sent and wait_for in out:
            os.write(master, keys)
            sent = True
        if probe and live is None and probe in out:
            live = lflags(slave)
            os.write(master, b'\n')
        if proc.poll() is not None and not ready:
            break
    if proc.poll() is None:
        proc.kill()
        raise AssertionError(f'process hung; output: {out[-400:]!r}')
    after = lflags(slave)
    os.close(master)
    os.close(slave)
    return proc.returncode, out.decode('utf8', 'replace'), before, live if probe else after


def main():
    temp = tempfile.mkdtemp(prefix='alambic-pty-')
    try:
        home = os.path.join(temp, 'home')
        os.makedirs(home)
        env = {'HOME': home, 'PATH': '/usr/bin:/bin', 'TERM': 'xterm'}
        code, out, before, after = run_in_pty([NODE, os.path.join(ROOT, '_meta/alambic.mjs'), 'setup'], env, b' \x1b[B\x03', b'Enter confirm')
        assert code == 130, f'Ctrl-C should exit 130, got {code}: {out[-400:]}'
        assert 'nothing written' in out, 'abort message missing'
        assert after == before, 'terminal mode not restored after Ctrl-C'
        written = [os.path.join(d, f) for d, _, files in os.walk(home) for f in files]
        assert not written, f'aborted setup wrote {written}'

        picker = os.path.join(ROOT, '_meta/lib/checkbox.mjs')
        hold = " process.stdout.write('PROBE\\n'); process.stdin.resume(); process.stdin.once('data', () => process.exit(0))"
        quit_script = (
            f"import('{picker}').then(async ({{ runPicker }}) => {{"
            " const rows = await runPicker([{ id: 'a', label: 'a', checked: false }]);"
            " console.log('result:' + rows);" + hold + " })"
        )
        code, out, before, live = run_in_pty([NODE, '-e', quit_script], env, b'\x03', b'Enter confirm', b'PROBE')
        assert code == 0 and 'result:null' in out, f'Ctrl-C should resolve null: {out[-400:]}'
        assert live == before, 'terminal mode not restored after Ctrl-C (checked while alive)'

        throw_script = (
            f"import('{picker}').then(async ({{ runPicker, render }}) => {{"
            " let n = 0;"
            " const draw = (s, t) => { if (n++) throw new Error('draw failed'); return render(s, t) };"
            " try { await runPicker([{ id: 'a', label: 'a', checked: false }], { draw }) }"
            " catch (e) { console.log('rejected:' + e.message) }" + hold + " })"
        )
        code, out, before, live = run_in_pty([NODE, '-e', throw_script], env, b'j', b'Enter confirm', b'PROBE')
        assert code == 0 and 'rejected:draw failed' in out, f'throwing draw should reject: {out[-400:]}'
        assert live == before, 'terminal mode not restored after a throwing draw (checked while alive)'
        print('checkbox-pty: ok')
    finally:
        shutil.rmtree(temp, ignore_errors=True)


main()
