import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runDoctor } from '../scripts/ct-doctor.mjs';
import {
  createSnapshot,
  listSnapshots,
  rollbackToSnapshot,
  safeInstallRelease,
} from '../scripts/ct-release.mjs';
import { makeSandbox } from './helpers.mjs';

function hasAgy() {
  return spawnSync('which', ['agy'], { encoding: 'utf8' }).status === 0;
}

test('Ring 5: release snapshot pruning, doctor health detection, and isolated rollback work end-to-end', () => {
  if (!hasAgy()) return;
  const sb = makeSandbox('ct-release-');
  try {
    const fakeHome = join(sb.dir, 'home');
    const cfgDir = join(fakeHome, '.gemini', 'config');
    const dataDir = join(fakeHome, '.gemini', 'antigravity', 'plugin_data', 'control-tower');
    mkdirSync(cfgDir, { recursive: true });
    const env = { ...process.env, HOME: fakeHome, AGY_CONFIG_DIR: cfgDir, AGY_CONTROL_TOWER_DATA_DIR: dataDir };

    // Copy current ./plugin to a temporary v1.2.9 package to simulate prior installed release
    const prevPlugin = join(sb.dir, 'prev-plugin');
    cpSync(join(process.cwd(), 'plugin'), prevPlugin, { recursive: true });
    const pjPath = join(prevPlugin, 'plugin.json');
    const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
    pj.version = '1.2.9';
    writeFileSync(pjPath, `${JSON.stringify(pj, null, 2)}\n`, 'utf8');

    // 1) Install v1.2.9 in isolated fakeHome
    execFileSync('agy', ['plugin', 'install', prevPlugin], { env, encoding: 'utf8' });

    // Doctor warns when installed v1.2.9 != repo version
    const docBefore = runDoctor({ env, configDir: cfgDir, dataDir, checkProcesses: false });
    assert.equal(docBefore.installedVersion, '1.2.9');
    assert.equal(docBefore.ok, true);
    assert.ok(docBefore.warnCount >= 1);

    // 2) Test pruning (create 4 snapshots -> keep last 3)
    for (let i = 1; i <= 4; i += 1) {
      createSnapshot({ env, configDir: cfgDir, dataDir, keep: 3, tagSuffix: `s${i}` });
    }
    assert.equal(listSnapshots({ env, dataDir }).length, 3);

    // 3) safeInstallRelease refuses without confirm
    assert.throws(() => safeInstallRelease({ confirm: false, env, configDir: cfgDir, dataDir }));

    // 4) safeInstallRelease with confirm upgrades to current repo plugin & snapshots v1.2.9
    const installRes = safeInstallRelease({
      confirm: true,
      env,
      configDir: cfgDir,
      dataDir,
      checkProcesses: false,
    });
    assert.equal(installRes.ok, true);
    assert.equal(installRes.snapshot.created, true);
    assert.equal(installRes.doctor.failedCount, 0);

    // 5) Instant rollback restores v1.2.9 cleanly via official agy plugin install
    const rb = rollbackToSnapshot({
      env,
      configDir: cfgDir,
      dataDir,
      checkProcesses: false,
    });
    assert.equal(rb.ok, true);
    assert.equal(rb.target.version, '1.2.9');
    assert.equal(rb.doctor.installedVersion, '1.2.9');

    // 6) Doctor detects legacy duplicate skill if present
    mkdirSync(join(cfgDir, 'skills', 'control-tower'), { recursive: true });
    const docDup = runDoctor({ env, configDir: cfgDir, dataDir, checkProcesses: false });
    assert.equal(docDup.ok, false);
    assert.ok(docDup.checks.some((c) => c.id === 'legacy_duplicate' && c.status === 'fail'));
  } finally {
    sb.cleanup();
  }
});
