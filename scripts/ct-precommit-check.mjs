#!/usr/bin/env node
/**
 * Cross-platform repository hygiene, privacy sanitization, version single-source-of-truth,
 * and offline plugin bundle validation gate. Invoked by scripts/git-hooks/pre-commit,
 * unit tests, and GitHub Actions CI across Linux, macOS, and Windows.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePluginBundleOffline } from './ct-validate-offline.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const forbHome = '/' + 'home' + '/';
const forbUsers = '/' + 'Users' + '/';
const winUsersRe = new RegExp('[A-Za-z]:[\\\\/]' + 'Us' + 'ers[\\\\/]', 'i');
const forbDot1 = String.fromCharCode(0x00b7);
const forbDot2 = String.fromCharCode(0x30fb);
const forbRm1 = 'rm ' + '-rf';
const forbRm2 = 'rm ' + '-fr';
const privateIpRe = new RegExp(
  '\\b(?:10\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01])|' + '192' + '\\.' + '168' + ')\\.\\d{1,3}\\.\\d{1,3}\\b'
);
const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function checkTextHygiene(buf, label) {
  if (!buf || buf.includes(0)) return;
  const txt = buf.toString('utf8');
  if (txt.includes(forbHome)) throw new Error(`个人路径泄漏于 ${label}`);
  if (txt.includes(forbUsers)) throw new Error(`个人路径泄漏于 ${label}`);
  if (winUsersRe.test(txt)) throw new Error(`Windows 个人路径泄漏于 ${label}`);
  if (privateIpRe.test(txt)) throw new Error(`内网 IP 泄漏于 ${label}`);
  if (uuidRe.test(txt)) throw new Error(`静态 UUID 泄漏于 ${label}`);
  if (txt.includes(forbDot1) || txt.includes(forbDot2)) {
    throw new Error(`非法间隔号字符出现在 ${label}`);
  }
  if (txt.includes(forbRm1) || txt.includes(forbRm2)) {
    throw new Error(`禁止出现的删除命令字面量存在于 ${label}`);
  }
}

export function runPrecommitCheck(repoRoot = REPO_ROOT) {
  const cwd = resolve(repoRoot);

  function gitShowStaged(relPath) {
    const r = spawnSync('git', ['show', `:${relPath}`], { cwd, maxBuffer: 16 * 1024 * 1024 });
    if (r.status === 0 && r.stdout) return r.stdout;
    return null;
  }

  const stagedRes = spawnSync(
    'git',
    ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'],
    { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
  );
  const hasGit = stagedRes.status === 0;
  const stagedFiles = hasGit ? stagedRes.stdout.split('\0').filter(Boolean) : [];

  function readManifestJson(relPath) {
    if (stagedFiles.length > 0) {
      const stagedBuf = gitShowStaged(relPath);
      if (stagedBuf) return JSON.parse(stagedBuf.toString('utf8'));
    }
    return JSON.parse(readFileSync(join(cwd, relPath), 'utf8'));
  }

  const rootPkg = readManifestJson('package.json');
  const pluginJson = readManifestJson('plugin/plugin.json');
  const sidecarPkg = readManifestJson('plugin/sidecars/tower/package.json');

  if (rootPkg.version !== pluginJson.version || sidecarPkg.version !== pluginJson.version) {
    throw new Error(
      `版本不一致: root=${rootPkg.version}, plugin=${pluginJson.version}, sidecar=${sidecarPkg.version}`
    );
  }

  if (stagedFiles.length > 0) {
    for (const rel of stagedFiles) {
      const buf = gitShowStaged(rel);
      if (buf) checkTextHygiene(buf, `${rel} (staged)`);
    }
  } else if (hasGit) {
    const lsRes = spawnSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    );
    const files = lsRes.status === 0 ? lsRes.stdout.split('\0').filter(Boolean) : [];
    for (const rel of files) {
      try {
        const full = join(cwd, rel);
        const st = lstatSync(full);
        if (st.isSymbolicLink() || !st.isFile()) continue;
        checkTextHygiene(readFileSync(full), rel);
      } catch (err) {
        if (err?.code === 'ENOENT') continue;
        throw err;
      }
    }
  } else {
    const SKIP_DIRS = new Set(['.git', '.agents', 'node_modules', '__pycache__', 'tmp']);
    function scan(dir) {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(ent.name)) continue;
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
          scan(full);
          continue;
        }
        const st = lstatSync(full);
        if (st.isSymbolicLink() || !st.isFile()) continue;
        checkTextHygiene(readFileSync(full), full);
      }
    }
    scan(cwd);
  }

  const offlineVal = validatePluginBundleOffline(join(cwd, 'plugin'));
  if (!offlineVal.ok) {
    const detail = offlineVal.findings.map((f) => `${f.code}: ${f.message}`).join('; ');
    throw new Error(`离线插件包校验失败: ${detail}`);
  }

  return { ok: true, version: pluginJson.version };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const res = runPrecommitCheck(REPO_ROOT);
    console.log(`OK: 隐私脱敏、零间隔号、离线包结构与版本一致性校验通过 (v${res.version})`);
    process.exit(0);
  } catch (err) {
    console.error(`FAIL: ${err?.message || err}`);
    process.exit(1);
  }
}
