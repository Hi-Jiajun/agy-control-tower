#!/usr/bin/env node
/**
 * Control Tower Ring 5: Read-Only Live Installation Health Probe (Doctor)
 * Verifies installed plugin version alignment, anti-double-discovery cleanliness,
 * active Antigravity registration, stale Sidecar process CWD detection,
 * 24h flight-log health, and release rollback snapshot inventory.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeFlightEvents } from '../plugin/lib/logger.mjs';
import { readJsonSafe, resolvePluginDataDir } from '../plugin/lib/paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

function resolveConfigDir(env = process.env, explicit = '') {
  if (explicit) return resolve(explicit);
  if (env.AGY_CONFIG_DIR && env.AGY_CONFIG_DIR.trim()) return resolve(env.AGY_CONFIG_DIR.trim());
  return join(resolve(env.HOME || homedir()), '.gemini', 'config');
}

function buildAgyChildEnv(env, cfgDir) {
  const next = { ...env, AGY_CONFIG_DIR: cfgDir };
  const parent = dirname(cfgDir);
  if (basename(cfgDir) === 'config' && basename(parent) === '.gemini') {
    next.HOME = dirname(parent);
  }
  return next;
}

export function inspectRunningSidecars(installedDir = '') {
  if (process.platform !== 'linux' || !existsSync('/proc')) {
    return { supported: false, running: [], stale: [] };
  }
  const running = [];
  const stale = [];
  let pluginMtimeMs = 0;
  const pjPath = installedDir ? join(installedDir, 'plugin.json') : '';
  if (pjPath && existsSync(pjPath)) {
    try {
      pluginMtimeMs = statSync(pjPath).mtimeMs;
    } catch {
      pluginMtimeMs = 0;
    }
  }
  let pids = [];
  try {
    pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return { supported: false, running: [], stale: [] };
  }
  for (const pid of pids) {
    const pidNum = Number(pid);
    if (pidNum === process.pid) continue;
    try {
      const rawArgs = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\u0000').filter(Boolean);
      if (rawArgs.length === 0) continue;
      const binBase = basename(rawArgs[0]);
      if (!/^node(?:\d|$|-|\.)/i.test(binBase)) continue;
      const cmdline = rawArgs.join(' ');
      if (!cmdline.includes('control-tower') || !cmdline.includes('sidecars/tower/main.mjs')) continue;
      let cwd = '';
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        cwd = '';
      }
      let procStartMs = 0;
      try {
        procStartMs = statSync(`/proc/${pid}`).mtimeMs;
      } catch {
        procStartMs = 0;
      }
      const deletedCwd = cwd.includes('(deleted)');
      const outdatedCode =
        cmdline.includes(installedDir) &&
        pluginMtimeMs > 0 &&
        procStartMs > 0 &&
        procStartMs < pluginMtimeMs - 1000;
      const entry = { pid: pidNum, deletedCwd, outdatedCode };
      running.push(entry);
      if (deletedCwd || outdatedCode) stale.push(entry);
    } catch {
      // process exited or unreadable
    }
  }
  return { supported: true, running, stale };
}

function listReleaseSnapshotDirs(dataDir) {
  const relDir = join(resolve(dataDir), 'releases');
  if (!existsSync(relDir)) return [];
  try {
    return readdirSync(relDir, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith('.tmp-') &&
          existsSync(join(relDir, e.name, 'manifest.json')) &&
          existsSync(join(relDir, e.name, 'plugin', 'plugin.json'))
      )
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export function runDoctor({
  env = process.env,
  configDir = '',
  dataDir = '',
  pluginRoot = join(REPO_ROOT, 'plugin'),
  checkAgyCli = true,
  checkProcesses = true,
} = {}) {
  const cfgDir = resolveConfigDir(env, configDir);
  const resolvedDataDir = dataDir ? resolve(dataDir) : resolvePluginDataDir({ env });
  const repoMeta = readJsonSafe(join(resolve(pluginRoot), 'plugin.json'), {});
  const repoVersion = String(repoMeta?.version || '');

  const installedDir = join(cfgDir, 'plugins', 'control-tower');
  const installedMeta = readJsonSafe(join(installedDir, 'plugin.json'), null);
  const installedVersion = String(installedMeta?.version || '');

  const checks = [];

  // 1) Installed plugin & version alignment
  if (!installedMeta) {
    checks.push({
      id: 'installed_plugin',
      status: 'fail',
      detail: `未检测到已安装的 control-tower 插件 (目标版本 v${repoVersion})`,
    });
  } else if (repoVersion && installedVersion !== repoVersion) {
    checks.push({
      id: 'installed_plugin',
      status: 'warn',
      detail: `已安装版本 v${installedVersion} 与源码仓 v${repoVersion} 不一致`,
    });
  } else {
    checks.push({
      id: 'installed_plugin',
      status: 'pass',
      detail: `已安装版本 v${installedVersion} 与源码仓一致`,
    });
  }

  // 2) Anti-double-discovery legacy skill check
  const legacySkillDir = join(cfgDir, 'skills', 'control-tower');
  if (existsSync(legacySkillDir)) {
    checks.push({
      id: 'legacy_duplicate',
      status: 'fail',
      detail: '检测到旧版散装 skills/control-tower 残留，可能触发双重发现，请用 cleanup-legacy-skill.sh 清理',
    });
  } else {
    checks.push({
      id: 'legacy_duplicate',
      status: 'pass',
      detail: '无旧版散装 skills/control-tower 残留',
    });
  }

  // 3) Official agy plugin list registration
  if (checkAgyCli) {
    const which = spawnSync('which', ['agy'], { encoding: 'utf8' });
    if (which.status === 0) {
      const childEnv = buildAgyChildEnv(env, cfgDir);
      const listed = spawnSync('agy', ['plugin', 'list', '--json'], {
        encoding: 'utf8',
        env: childEnv,
      });
      if (listed.status === 0) {
        try {
          const parsed = JSON.parse(listed.stdout || '[]');
          const arr = Array.isArray(parsed) ? parsed : parsed.plugins || [];
          const hit = arr.find((p) => p?.name === 'control-tower');
          if (hit && hit.enabled !== false) {
            checks.push({
              id: 'agy_registry',
              status: 'pass',
              detail: `agy plugin list 已启用 control-tower (v${hit.version || installedVersion})`,
            });
          } else if (hit) {
            checks.push({
              id: 'agy_registry',
              status: 'warn',
              detail: 'control-tower 已安装但处于 disabled 状态',
            });
          } else {
            checks.push({
              id: 'agy_registry',
              status: 'fail',
              detail: 'agy plugin list 未发现 control-tower',
            });
          }
        } catch {
          checks.push({
            id: 'agy_registry',
            status: 'warn',
            detail: 'agy plugin list --json 输出解析异常',
          });
        }
      } else {
        checks.push({
          id: 'agy_registry',
          status: 'warn',
          detail: 'agy plugin list 执行返回非零状态',
        });
      }
    } else {
      checks.push({
        id: 'agy_registry',
        status: 'warn',
        detail: '当前 PATH 未找到 agy CLI，跳过注册表核验',
      });
    }
  }

  // 4) Running Sidecar process health
  if (checkProcesses) {
    const procInfo = inspectRunningSidecars(installedDir);
    if (procInfo.supported) {
      if (procInfo.stale.length > 0) {
        checks.push({
          id: 'sidecar_process',
          status: 'warn',
          detail: `发现 ${procInfo.stale.length} 个旧版或失效目录残留 Sidecar 进程 (PID: ${procInfo.stale
            .map((p) => p.pid)
            .join(', ')})，建议关闭并重开面板`,
        });
      } else {
        checks.push({
          id: 'sidecar_process',
          status: 'pass',
          detail:
            procInfo.running.length > 0
              ? `运行中 Sidecar 进程 ${procInfo.running.length} 个，目录健康`
              : '当前无常驻 Sidecar 进程（按需拉起正常）',
        });
      }
    }
  }

  // 5) Flight recorder 24h health
  const flight = summarizeFlightEvents(resolvedDataDir);
  if ((flight.byLevel?.error || 0) > 0) {
    checks.push({
      id: 'flight_logs',
      status: 'warn',
      detail: `近 24h 黑匣子捕获 ${flight.byLevel.error} 条错误 / ${flight.byLevel.warn} 条警告 (慢调用 ${flight.slowCount})`,
    });
  } else {
    checks.push({
      id: 'flight_logs',
      status: 'pass',
      detail: `近 24h 黑匣子 0 错误 (${flight.total} 条事件, ${flight.byLevel.warn} 条警告, ${flight.slowCount} 次慢调用)`,
    });
  }

  // 6) Release snapshot inventory
  const snapshots = listReleaseSnapshotDirs(resolvedDataDir);
  checks.push({
    id: 'release_snapshots',
    status: 'pass',
    detail:
      snapshots.length > 0
        ? `可回滚发布快照 ${snapshots.length} 份 (最新: ${snapshots[0]})`
        : '尚无发布快照（首次使用 ct-release 实装时自动生成）',
  });

  const failedCount = checks.filter((c) => c.status === 'fail').length;
  const warnCount = checks.filter((c) => c.status === 'warn').length;

  return {
    ok: failedCount === 0,
    failedCount,
    warnCount,
    repoVersion,
    installedVersion,
    snapshots,
    checks,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const noProc = args.includes('--no-proc');
  const cfgArg = args.find((a) => a.startsWith('--config-dir='));
  const dataArg = args.find((a) => a.startsWith('--data-dir='));

  const res = runDoctor({
    configDir: cfgArg ? cfgArg.slice('--config-dir='.length) : '',
    dataDir: dataArg ? dataArg.slice('--data-dir='.length) : '',
    checkProcesses: !noProc,
  });

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  } else {
    for (const c of res.checks) {
      const icon = c.status === 'pass' ? 'PASS' : c.status === 'warn' ? 'WARN' : 'FAIL';
      console.log(`[${icon}] ${c.id}: ${c.detail}`);
    }
    console.log(`----\nDoctor: ${res.ok ? 'HEALTHY' : 'UNHEALTHY'} (fail=${res.failedCount}, warn=${res.warnCount})`);
  }
  process.exit(res.ok ? 0 : 1);
}
