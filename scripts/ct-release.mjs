#!/usr/bin/env node
/**
 * Control Tower Ring 5: Release Snapshot, Safe Install Pipeline & Instant Rollback
 * Stores pre-install plugin package snapshots in <PLUGIN_DATA>/releases/ (keeping last 3),
 * and performs all installations/rollbacks strictly via official `agy plugin install`.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFlightEvent } from '../plugin/lib/logger.mjs';
import { readJsonSafe, resolvePluginDataDir } from '../plugin/lib/paths.mjs';
import { inspectRunningSidecars, runDoctor } from './ct-doctor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
export const MAX_RELEASE_SNAPSHOTS = 3;

function resolveConfigDir(env = process.env, explicit = '') {
  if (explicit) return resolve(explicit);
  if (env.AGY_CONFIG_DIR && env.AGY_CONFIG_DIR.trim()) return resolve(env.AGY_CONFIG_DIR.trim());
  return join(resolve(env.HOME || env.USERPROFILE || homedir()), '.gemini', 'config');
}

function getReleasesDir(dataDir) {
  return join(resolve(dataDir), 'releases');
}

function buildAgyChildEnv(env, cfgDir) {
  const next = { ...env, AGY_CONFIG_DIR: cfgDir };
  const parent = dirname(cfgDir);
  if (basename(cfgDir) === 'config' && basename(parent) === '.gemini') {
    next.HOME = dirname(parent);
  }
  return next;
}

function countFiles(dir) {
  let n = 0;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) n += countFiles(full);
    else if (ent.isFile() || ent.isSymbolicLink()) n += 1;
  }
  return n;
}

export function listSnapshots({ env = process.env, dataDir = '' } = {}) {
  const resolvedDataDir = dataDir ? resolve(dataDir) : resolvePluginDataDir({ env });
  const relDir = getReleasesDir(resolvedDataDir);
  if (!existsSync(relDir)) return [];
  const entries = readdirSync(relDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.tmp-'))
    .map((e) => {
      const dir = join(relDir, e.name);
      const manifest = readJsonSafe(join(dir, 'manifest.json'), null);
      const pluginJson = readJsonSafe(join(dir, 'plugin', 'plugin.json'), null);
      if (!manifest || !pluginJson || !pluginJson.version) return null;
      return {
        name: e.name,
        dir,
        pluginDir: join(dir, 'plugin'),
        version: manifest.version || pluginJson.version,
        createdAt: manifest.createdAt || '',
        fileCount: manifest.fileCount || 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.name.localeCompare(a.name));
  return entries;
}

export function pruneSnapshots({ env = process.env, dataDir = '', keep = MAX_RELEASE_SNAPSHOTS } = {}) {
  const snaps = listSnapshots({ env, dataDir });
  const removed = [];
  for (const old of snaps.slice(Math.max(1, keep))) {
    rmSync(old.dir, { recursive: true, force: true });
    removed.push(old.name);
  }
  return removed;
}

export function createSnapshot({
  env = process.env,
  configDir = '',
  dataDir = '',
  keep = MAX_RELEASE_SNAPSHOTS,
  tagSuffix = '',
} = {}) {
  const cfgDir = resolveConfigDir(env, configDir);
  const resolvedDataDir = dataDir ? resolve(dataDir) : resolvePluginDataDir({ env });
  const installedDir = join(cfgDir, 'plugins', 'control-tower');
  const installedMeta = readJsonSafe(join(installedDir, 'plugin.json'), null);
  if (!installedMeta) {
    return { created: false, reason: 'No currently installed control-tower plugin to snapshot' };
  }

  const version = String(installedMeta.version || '0.0.0').replace(/[^0-9A-Za-z._-]/g, '');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const unique = tagSuffix ? `-${String(tagSuffix).replace(/[^0-9A-Za-z_-]/g, '')}` : `-${Math.random().toString(16).slice(2, 6)}`;
  const snapName = `${stamp}-v${version}${unique}`;
  const relRoot = getReleasesDir(resolvedDataDir);
  const snapDir = join(relRoot, snapName);
  const tmpSnapDir = join(relRoot, `.tmp-${snapName}-${process.pid}`);
  const tmpPluginDir = join(tmpSnapDir, 'plugin');
  const snapPluginDir = join(snapDir, 'plugin');

  let fileCount = 0;
  let manifest = null;
  try {
    mkdirSync(tmpPluginDir, { recursive: true });
    cpSync(installedDir, tmpPluginDir, { recursive: true, verbatimSymlinks: true });
    if (!readJsonSafe(join(tmpPluginDir, 'plugin.json'), null)?.version) {
      throw new Error('Copied snapshot missing valid plugin.json');
    }
    fileCount = countFiles(tmpPluginDir);
    manifest = {
      name: snapName,
      version,
      createdAt: new Date().toISOString(),
      fileCount,
    };
    writeFileSync(join(tmpSnapDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    renameSync(tmpSnapDir, snapDir);
  } catch (err) {
    rmSync(tmpSnapDir, { recursive: true, force: true });
    throw err;
  }

  const pruned = pruneSnapshots({ env, dataDir: resolvedDataDir, keep });
  appendFlightEvent(resolvedDataDir, {
    level: 'info',
    source: 'release',
    event: 'release_snapshot_created',
    message: `Created pre-install snapshot ${snapName} (${fileCount} files)`,
    detail: { version, fileCount, prunedCount: pruned.length },
  });

  return {
    created: true,
    snapshot: { ...manifest, dir: snapDir, pluginDir: snapPluginDir },
    pruned,
  };
}

function recycleStaleSidecars(cfgDir, resolvedDataDir) {
  const installedDir = join(cfgDir, 'plugins', 'control-tower');
  const procCheck = inspectRunningSidecars(installedDir);
  if (!procCheck.supported || procCheck.stale.length === 0) return [];
  const recycled = [];
  for (const s of procCheck.stale) {
    try {
      process.kill(s.pid, 'SIGTERM');
      recycled.push(s.pid);
    } catch {
      // already exited
    }
  }
  if (recycled.length > 0) {
    const waitBuf = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 8; i++) {
      if (recycled.every((pid) => !existsSync(`/proc/${pid}`))) break;
      Atomics.wait(waitBuf, 0, 0, 35);
    }
    appendFlightEvent(resolvedDataDir, {
      level: 'info',
      source: 'release',
      event: 'sidecar_recycled_on_install',
      message: `Recycled ${recycled.length} stale Sidecar process(es) so host respawns fresh code`,
      detail: { pids: recycled },
    });
  }
  return recycled;
}

export function rollbackToSnapshot({
  snapshotName = '',
  env = process.env,
  configDir = '',
  dataDir = '',
  pluginRoot = join(REPO_ROOT, 'plugin'),
  checkProcesses = false,
} = {}) {
  const resolvedDataDir = dataDir ? resolve(dataDir) : resolvePluginDataDir({ env });
  const snaps = listSnapshots({ env, dataDir: resolvedDataDir });
  if (snaps.length === 0) {
    throw new Error('没有可用的发布快照可供回滚');
  }
  const target = snapshotName
    ? snaps.find((s) => s.name === snapshotName || s.version === snapshotName)
    : snaps[0];
  if (!target) {
    throw new Error(`未找到匹配快照: ${snapshotName}`);
  }
  if (!existsSync(join(target.pluginDir, 'plugin.json'))) {
    throw new Error(`快照目录损坏，缺少 plugin.json: ${target.name}`);
  }

  const cfgDir = resolveConfigDir(env, configDir);
  const childEnv = buildAgyChildEnv(env, cfgDir);
  execFileSync('agy', ['plugin', 'install', target.pluginDir], { env: childEnv, encoding: 'utf8' });
  if (checkProcesses) {
    recycleStaleSidecars(cfgDir, resolvedDataDir);
  }
  appendFlightEvent(resolvedDataDir, {
    level: 'warn',
    source: 'release',
    event: 'release_rollback_executed',
    message: `Rolled back control-tower to snapshot ${target.name} (v${target.version})`,
    detail: { snapshot: target.name, version: target.version },
  });

  const doctor = runDoctor({
    env,
    configDir,
    dataDir: resolvedDataDir,
    pluginRoot: target.pluginDir,
    checkProcesses,
  });

  return { ok: doctor.ok, target, doctor };
}

export function safeInstallRelease({
  confirm = false,
  env = process.env,
  configDir = '',
  dataDir = '',
  pluginRoot = join(REPO_ROOT, 'plugin'),
  checkProcesses = false,
} = {}) {
  if (!confirm) {
    throw new Error('安全门禁：执行实装发布必须显式传入 --confirm 标志（并获用户授权）。');
  }
  const absPlugin = resolve(pluginRoot);
  const cfgDir = resolveConfigDir(env, configDir);
  const childEnv = buildAgyChildEnv(env, cfgDir);
  execFileSync('agy', ['plugin', 'validate', '--strict', absPlugin], { env: childEnv, encoding: 'utf8' });

  const resolvedDataDir = dataDir ? resolve(dataDir) : resolvePluginDataDir({ env });
  const snapshotRes = createSnapshot({ env, configDir, dataDir: resolvedDataDir });

  execFileSync('agy', ['plugin', 'install', absPlugin], { env: childEnv, encoding: 'utf8' });
  if (checkProcesses) {
    recycleStaleSidecars(cfgDir, resolvedDataDir);
  }
  const newMeta = readJsonSafe(join(absPlugin, 'plugin.json'), {});

  appendFlightEvent(resolvedDataDir, {
    level: 'info',
    source: 'release',
    event: 'release_installed',
    message: `Installed control-tower v${newMeta?.version || 'unknown'}`,
    detail: { version: newMeta?.version || '', snapshotCreated: snapshotRes.created },
  });

  const doctor = runDoctor({
    env,
    configDir,
    dataDir: resolvedDataDir,
    pluginRoot: absPlugin,
    checkProcesses,
  });

  return { ok: doctor.ok, version: newMeta?.version || '', snapshot: snapshotRes, doctor };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'list';
  const jsonMode = args.includes('--json');
  const confirm = args.includes('--confirm');
  const cfgArg = args.find((a) => a.startsWith('--config-dir='));
  const dataArg = args.find((a) => a.startsWith('--data-dir='));
  const common = {
    configDir: cfgArg ? cfgArg.slice('--config-dir='.length) : '',
    dataDir: dataArg ? dataArg.slice('--data-dir='.length) : '',
  };

  try {
    if (cmd === 'list') {
      const snaps = listSnapshots(common);
      if (jsonMode) {
        process.stdout.write(`${JSON.stringify(snaps, null, 2)}\n`);
      } else if (snaps.length === 0) {
        console.log('暂无发布快照。');
      } else {
        for (const s of snaps) {
          console.log(`${s.name} | v${s.version} | ${s.fileCount} files | ${s.createdAt}`);
        }
      }
      process.exit(0);
    }

    if (cmd === 'snapshot') {
      const res = createSnapshot(common);
      if (jsonMode) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      else console.log(res.created ? `OK: 已创建快照 ${res.snapshot.name}` : `SKIP: ${res.reason}`);
      process.exit(0);
    }

    if (cmd === 'rollback') {
      const targetArg = args[1] && !args[1].startsWith('--') ? args[1] : '';
      const res = rollbackToSnapshot({ ...common, snapshotName: targetArg });
      if (jsonMode) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      else console.log(`OK: 已回滚至 ${res.target.name} (v${res.target.version}), doctor=${res.doctor.ok ? 'HEALTHY' : 'UNHEALTHY'}`);
      process.exit(res.ok ? 0 : 1);
    }

    if (cmd === 'install') {
      const res = safeInstallRelease({ ...common, confirm, checkProcesses: true });
      if (jsonMode) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      else console.log(`OK: 已安全实装 v${res.version}, doctor=${res.doctor.ok ? 'HEALTHY' : 'UNHEALTHY'}`);
      process.exit(res.ok ? 0 : 1);
    }

    console.error(`未知子命令: ${cmd} (支持: list | snapshot | install --confirm | rollback [name])`);
    process.exit(1);
  } catch (err) {
    console.error(`FAIL: ${err?.message || err}`);
    process.exit(1);
  }
}
