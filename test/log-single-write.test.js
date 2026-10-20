// Regression test for the substation.log duplication bug (2026-09-25 WO).
//
// Root cause: log() in src/index.js does BOTH console.log(line) (stdout)
// AND writeFileSync(LOG_PATH, line + '\n', { flag: 'a' }) (a direct write to
// the same file), for every single call. Under the real launchd deployment,
// the plist's StandardOutPath points at this exact same substation.log
// file, so stdout (carrying the console.log line) and the direct
// writeFileSync both land in that one file -- every line appears twice.
//
// This test reproduces that exact condition rather than just asserting a
// helper was called: it spawns a child node process whose real stdout fd is
// redirected to the SAME file log()'s writeFileSync targets -- mirroring
// launchd's StandardOutPath pointing at the identical substation.log path
// -- then calls log() once inside that child and inspects the real file on
// disk for how many copies of the line landed.
//
// RED (pre-fix): console.log() always fires, so the probe line lands twice
// (once via the redirected stdout fd, once via writeFileSync).
// GREEN (post-fix): console.log() is skipped when stdout is not a TTY --
// exactly the launchd/redirected-to-a-file condition simulated here -- so
// only the writeFileSync path writes, producing exactly one line.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = join(__dirname, '..', 'src', 'index.js');

test('log() writes each line exactly once to substation.log, even when stdout is redirected to that same file (as launchd\'s StandardOutPath does in production)', () => {
  // Isolated fake HOME so this test never touches the real, live
  // ~/.substation/substation.log (LOG_PATH is derived from homedir() at
  // module load).
  const fakeHome = mkdtempSync(join(tmpdir(), 'substation-log-test-'));
  const logDir = join(fakeHome, '.substation');
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, 'substation.log');

  const probe = `PROBE_LINE_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  // Open the SAME file log()'s writeFileSync will target, and hand its fd
  // to the child as its real stdout -- exactly mirroring launchd's
  // StandardOutPath pointing at the identical substation.log path.
  const stdoutFd = openSync(logPath, 'a');

  const script = `
    import { log } from ${JSON.stringify(SRC_PATH)};
    log(${JSON.stringify(probe)});
    process.exit(0);
  `;

  let result;
  try {
    result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME: fakeHome },
      stdio: ['ignore', stdoutFd, 'pipe'],
      encoding: 'utf8',
      timeout: 10000,
    });
  } finally {
    closeSync(stdoutFd);
  }

  // src/index.js schedules top-level setInterval timers on import (unrelated
  // to this bug), which would otherwise keep the child process alive
  // forever -- the explicit process.exit(0) above is required, and the
  // spawnSync `timeout` is a safety net in case that ever regresses.
  assert.equal(result.signal, null, `child process was killed (signal ${result.signal}), likely hung on import-time timers instead of exiting`);
  assert.equal(result.status, 0, `child process failed (status ${result.status}): ${result.stderr || result.error}`);

  const contents = readFileSync(logPath, 'utf8');
  const matches = contents.split('\n').filter(line => line.includes(probe));
  assert.equal(
    matches.length,
    1,
    `expected exactly 1 line containing the probe in ${logPath}, got ${matches.length}:\n${contents}`,
  );

  rmSync(fakeHome, { recursive: true, force: true });
});
