// Regression test for the "SubStation can silently run old code for days"
// gap (WO 2026-09-25 fix3). Live incident: commit 1609bd8 (fixing the
// "commands run twice" bug) landed 2026-09-24 00:35, but the live process
// (PID 76155, started 2026-09-22 22:16) kept serving the OLD pre-fix code
// for ~43 hours -- nothing anywhere reported that mismatch.
//
// getDeployStatus() records runningCommit / loadedDistHash / startedAt once
// at module load (what actually got loaded into memory when this process
// started), then re-hashes dist/index.js FRESH on every call and compares
// against that stored loadedDistHash to compute staleCode. This test drives
// that comparison directly via getDeployStatus()'s testDeps.distPath
// override, pointed at a throwaway fixture file -- it never reads, writes,
// or otherwise touches the real, live dist/index.js on disk.
//
// RED (pre-fix): getDeployStatus doesn't exist / doesn't expose staleCode,
// so this test fails to import or fails the assertions.
// GREEN (post-fix): staleCode is false while the fixture's bytes match what
// this module loaded at startup, and flips to true the moment the fixture
// file's on-disk content changes -- without restarting anything.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDeployStatus } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The real, live dist/index.js -- read-only, purely to seed the fixture
// file with bytes that match what this process actually loaded at module
// load time (so the "not stale yet" baseline is genuine, not contrived).
const REAL_DIST_PATH = join(__dirname, '..', 'dist', 'index.js');

test('staleCode is false when the on-disk file still matches what was loaded, and flips to true the moment its content changes', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'substation-stale-code-test-'));
  const fixturePath = join(fixtureDir, 'index.js');

  try {
    // Seed the fixture with the exact bytes this module loaded at startup
    // (loadedDistHash was computed from the real dist/index.js, since the
    // test imports src/index.js directly). This is the "just deployed,
    // nothing has drifted" baseline.
    writeFileSync(fixturePath, readFileSync(REAL_DIST_PATH));

    const before = getDeployStatus({ distPath: fixturePath });
    assert.equal(before.staleCode, false, 'staleCode must be false when the on-disk file matches loadedDistHash');
    assert.ok(before.runningCommit, 'runningCommit must be populated');
    assert.ok(before.loadedDistHash, 'loadedDistHash must be populated');
    assert.ok(before.startedAt, 'startedAt must be populated');

    // Now mutate the on-disk file -- simulating a `git commit` + mirror to
    // dist/index.js landing while this process keeps running with the old
    // code already in memory (the exact 1609bd8 incident).
    writeFileSync(fixturePath, readFileSync(REAL_DIST_PATH).toString('utf8') + '\n// drifted\n');

    const after = getDeployStatus({ distPath: fixturePath });
    assert.equal(after.staleCode, true, 'staleCode must flip to true once the on-disk file no longer matches what was loaded');

    // loadedDistHash and runningCommit are fixed at module load and must
    // never change just because the on-disk file did -- only staleCode is
    // computed fresh per call.
    assert.equal(after.loadedDistHash, before.loadedDistHash);
    assert.equal(after.runningCommit, before.runningCommit);

    // Restoring the original bytes flips staleCode back to false -- proving
    // this is a live, per-request comparison rather than a one-shot flag.
    writeFileSync(fixturePath, readFileSync(REAL_DIST_PATH));
    const restored = getDeployStatus({ distPath: fixturePath });
    assert.equal(restored.staleCode, false, 'staleCode must go back to false once the on-disk file matches loadedDistHash again');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('getDeployStatus falls back to a non-stale-looking read failure (not a crash) when the dist file is missing', () => {
  const missingPath = join(tmpdir(), `substation-stale-code-missing-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  const status = getDeployStatus({ distPath: missingPath });
  // Can't hash a file that isn't there -- must fail soft, not throw, and
  // must not be reported as stale purely due to a read error.
  assert.equal(status.staleCode, false);
});
