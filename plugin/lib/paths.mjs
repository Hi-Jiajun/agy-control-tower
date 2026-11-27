import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REGISTRY_CANDIDATES = [
  '.agents/SESSION-REGISTRY.md',
  'research/SESSION-REGISTRY.md',
  'SESSION-REGISTRY.md',
];

export const MANAGED_REGISTRY_VIRTUAL_REL = '@plugin_data/SESSION-REGISTRY.md';

const ALLOWED_REGISTRY_SET = new Set(REGISTRY_CANDIDATES);

export function getWorkspaceSettingsDir(dataDir, wsReal) {
  return join(resolve(dataDir), 'workspaces', sha256(wsReal).slice(0, 16));
}

export function getManagedRegistryPath(dataDir, wsReal) {
  return join(getWorkspaceSettingsDir(dataDir, wsReal), 'SESSION-REGISTRY.md');
}

export function getRecentWorkspacesPath(dataDir) {
  return join(resolve(dataDir), 'recent-workspaces.json');
}

/**
 * Strictly read-only discovery of known workspaces across recent-workspaces.json,
 * persisted inbox metadata, and bounded sibling-directory hash matching.
 */
export function loadKnownWorkspaces(dataDir, { seedWorkspaces = [], maxEntries = 24 } = {}) {
  const result = [];
  const seen = new Set();
  const matchedHashes = new Set();

  const addCandidate = (raw) => {
    if (!raw || typeof raw !== 'string') return;
    const wsReal = normalizeWorkspaceInput(raw, { throwOnInvalid: false });
    if (!wsReal || seen.has(wsReal)) return;
    seen.add(wsReal);
    matchedHashes.add(sha256(wsReal).slice(0, 16));
    result.push(wsReal);
  };

  for (const s of Array.isArray(seedWorkspaces) ? seedWorkspaces : []) {
    addCandidate(s);
  }

  if (!dataDir || !existsSync(dataDir)) {
    return result.slice(0, maxEntries);
  }

  const recentRaw = readJsonSafe(getRecentWorkspacesPath(dataDir), []);
  if (Array.isArray(recentRaw)) {
    for (const item of recentRaw) addCandidate(item);
  }

  const wsRoot = join(resolve(dataDir), 'workspaces');
  const unknownHashes = new Set();
  if (existsSync(wsRoot)) {
    try {
      for (const ent of readdirSync(wsRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const inboxRaw = readJsonSafe(join(wsRoot, ent.name, 'inbox.json'), null);
        if (inboxRaw && typeof inboxRaw.workspace === 'string' && inboxRaw.workspace.trim()) {
          addCandidate(inboxRaw.workspace);
        }
        if (!matchedHashes.has(ent.name)) {
          unknownHashes.add(ent.name);
        }
      }
    } catch {
      // ignore unreadable workspaces dir
    }
  }

  // Bounded read-only parent/sibling hash backfill for pre-v1.7.1 workspace directories
  if (unknownHashes.size > 0 && result.length > 0) {
    const parentDirs = new Set();
    const homeReal = getHomeDir();
    for (const known of [...result]) {
      const p1 = dirname(known);
      if (p1 && p1 !== '/' && p1 !== known) {
        parentDirs.add(p1);
        const p2 = dirname(p1);
        if (p2 && p2 !== '/' && p2 !== p1 && p2 !== dirname(homeReal)) {
          parentDirs.add(p2);
        }
      }
    }
    for (const pDir of parentDirs) {
      if (unknownHashes.size === 0) break;
      try {
        const pReal = realpathSync(pDir);
        const pHash = sha256(pReal).slice(0, 16);
        if (unknownHashes.has(pHash)) {
          addCandidate(pReal);
          unknownHashes.delete(pHash);
        }
        const entries = readdirSync(pReal, { withFileTypes: true }).slice(0, 80);
        for (const ent of entries) {
          if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name === 'node_modules') continue;
          const childAbs = join(pReal, ent.name);
          try {
            const childReal = realpathSync(childAbs);
            const h = sha256(childReal).slice(0, 16);
            if (unknownHashes.has(h)) {
              addCandidate(childReal);
              unknownHashes.delete(h);
            }
          } catch {
            // ignore broken symlink
          }
        }
      } catch {
        // ignore unreadable parent dir
      }
    }
  }

  return result.slice(0, maxEntries);
}

export function recordKnownWorkspace(dataDir, wsReal, { maxEntries = 24 } = {}) {
  const cleanWs = normalizeWorkspaceInput(wsReal, { throwOnInvalid: false });
  if (!dataDir || !cleanWs) return [];
  const lockPath = join(resolve(dataDir), '.recent.lock');
  return withFileLockSync(lockPath, () => {
    const recentPath = getRecentWorkspacesPath(dataDir);
    const raw = readJsonSafe(recentPath, []);
    const existing = Array.isArray(raw)
      ? raw.filter((item) => typeof item === 'string' && item !== cleanWs && existsSync(item))
      : [];
    const next = [cleanWs, ...existing].slice(0, maxEntries);
    atomicWriteText(recentPath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function validateCustomRegistryRelPath(relPath) {
  if (typeof relPath !== 'string') {
    throw new PathError(403, 'Custom registry path must be a string');
  }
  const trimmed = relPath.trim();
  if (!trimmed || trimmed !== relPath || trimmed.length > 180) {
    throw new PathError(403, 'Invalid custom registry relative path');
  }
  if (/[\u0000-\u001f\u007f\\]/.test(trimmed)) {
    throw new PathError(403, 'Custom registry path contains disallowed characters');
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('@') || /^[A-Za-z]:/.test(trimmed)) {
    throw new PathError(403, 'Custom registry path must be workspace-relative');
  }
  if (!trimmed.endsWith('.md')) {
    throw new PathError(403, 'Custom registry path must end with .md');
  }
  const segments = trimmed.split('/');
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new PathError(403, 'Path traversal blocked in custom registry path');
  }
  return trimmed;
}

export function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function getHomeDir(env = process.env) {
  return resolve(env.HOME || env.USERPROFILE || homedir());
}

function findAncestorParent(startPath, markerName) {
  if (!startPath || typeof startPath !== 'string') return '';
  let cur = resolve(startPath.trim());
  for (let i = 0; i < 16; i += 1) {
    const parent = dirname(cur);
    if (cur.endsWith(`${sep}${markerName}`)) {
      return parent;
    }
    if (parent === cur) break;
    cur = parent;
  }
  return '';
}

function safeListDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((ent) => ent.isDirectory())
      .map((ent) => join(dir, ent.name));
  } catch {
    return [];
  }
}

const APP_DIRS_CACHE_TTL_MS = 5000;
let appDirsCache = { key: '', expiresAt: 0, dirs: [] };

/**
 * Resolve candidate Antigravity app data directories (<appDataDir> containing brain/).
 */
export function resolveAppDataDirs({ env = process.env, hintPath = '' } = {}) {
  const cacheKey = `${env.ANTIGRAVITY_APP_DATA_DIR || ''}|${env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || ''}|${env.HOME || ''}|${env.USERPROFILE || ''}|${hintPath || ''}`;
  const now = Date.now();
  if (appDirsCache.key === cacheKey && now < appDirsCache.expiresAt && appDirsCache.dirs.length > 0) {
    return [...appDirsCache.dirs];
  }

  const seen = new Set();
  const list = [];
  const pushDir = (cand) => {
    if (!cand) return;
    const abs = resolve(cand);
    if (!seen.has(abs)) {
      seen.add(abs);
      list.push(abs);
    }
  };

  if (env.ANTIGRAVITY_APP_DATA_DIR && env.ANTIGRAVITY_APP_DATA_DIR.trim()) {
    pushDir(env.ANTIGRAVITY_APP_DATA_DIR.trim());
    appDirsCache = { key: cacheKey, expiresAt: now + APP_DIRS_CACHE_TTL_MS, dirs: list };
    return [...list];
  }

  const fromHint = findAncestorParent(hintPath, 'brain');
  if (fromHint) pushDir(fromHint);

  const execDataDir = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execDataDir) {
    const fromSidecar = findAncestorParent(execDataDir, 'sidecar_data');
    if (fromSidecar) pushDir(fromSidecar);
  }

  const geminiRoot = join(getHomeDir(env), '.gemini');
  const preferredOrder = ['antigravity', 'antigravity-ide', 'antigravity-cli'];
  for (const name of preferredOrder) {
    const cand = join(geminiRoot, name);
    if (existsSync(join(cand, 'brain'))) pushDir(cand);
  }
  for (const sub of safeListDirs(geminiRoot).sort()) {
    if (existsSync(join(sub, 'brain'))) pushDir(sub);
  }

  if (list.length === 0) {
    pushDir(join(geminiRoot, 'antigravity'));
  }
  appDirsCache = { key: cacheKey, expiresAt: now + APP_DIRS_CACHE_TTL_MS, dirs: list };
  return [...list];
}

/**
 * Resolve persistent plugin_data directory without creating it on read.
 */
export function resolvePluginDataDir({ env = process.env, hintPath = '' } = {}) {
  if (env.AGY_CONTROL_TOWER_DATA_DIR && env.AGY_CONTROL_TOWER_DATA_DIR.trim()) {
    return resolve(env.AGY_CONTROL_TOWER_DATA_DIR.trim());
  }
  if (env.PLUGIN_DATA && env.PLUGIN_DATA.trim()) {
    const candidate = resolve(env.PLUGIN_DATA.trim());
    if (basename(candidate) === 'control-tower') {
      return candidate;
    }
  }
  const appDirs = resolveAppDataDirs({ env, hintPath });
  return join(appDirs[0], 'plugin_data', 'control-tower');
}

export class PathError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function normalizeWorkspaceInput(raw, { throwOnInvalid = false } = {}) {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text) return null;
  if (text.startsWith('file://')) {
    try {
      text = fileURLToPath(text);
    } catch {
      if (throwOnInvalid) throw new PathError(400, 'Invalid workspace file URI');
      return null;
    }
  }
  if (!isAbsolute(text)) {
    text = resolve(text);
  }
  if (!existsSync(text)) {
    if (throwOnInvalid) throw new PathError(400, 'Workspace directory does not exist');
    return null;
  }
  try {
    const real = realpathSync(text);
    if (!statSync(real).isDirectory()) {
      if (throwOnInvalid) throw new PathError(400, 'Workspace path is not a directory');
      return null;
    }
    return real;
  } catch {
    if (throwOnInvalid) throw new PathError(400, 'Failed to resolve workspace directory');
    return null;
  }
}

export function isInsideDir(rootReal, targetReal) {
  const normDrive = (p) =>
    process.platform === 'win32' && /^[a-z]:/i.test(p) ? p[0].toUpperCase() + p.slice(1) : p;
  const rel = relative(normDrive(rootReal), normDrive(targetReal));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function canonicalizeMissingRoot(absPath) {
  let cur = resolve(absPath);
  const tail = [];
  for (let i = 0; i < 32; i += 1) {
    if (existsSync(cur)) {
      try {
        return join(realpathSync(cur), ...tail.reverse());
      } catch {
        return resolve(absPath);
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.push(basename(cur));
    cur = parent;
  }
  return resolve(absPath);
}

export function assertSafeTargetWithinRoot(
  rootReal,
  candidate,
  { allowMissing = false, rootLabel = 'workspace', notFoundMessage = 'SESSION-REGISTRY.md not found' } = {}
) {
  const rootCanon = canonicalizeMissingRoot(rootReal);
  if (!isInsideDir(rootCanon, candidate)) {
    throw new PathError(403, 'Path traversal blocked');
  }

  // Walk up to nearest existing ancestor within rootCanon to prevent multi-level symlink directory escape
  let anc = dirname(candidate);
  for (let depth = 0; depth < 32; depth += 1) {
    if (!isInsideDir(rootCanon, anc)) break;
    let ancLst = null;
    try {
      ancLst = lstatSync(anc);
    } catch {
      ancLst = null;
    }
    if (ancLst) {
      let ancReal;
      try {
        ancReal = realpathSync(anc);
      } catch {
        throw new PathError(403, `Parent symlink escapes ${rootLabel}`);
      }
      if (!isInsideDir(rootCanon, ancReal)) {
        throw new PathError(403, `Parent symlink escapes ${rootLabel}`);
      }
      break;
    }
    if (anc === rootCanon) break;
    const nextAnc = dirname(anc);
    if (nextAnc === anc) break;
    anc = nextAnc;
  }

  let lst = null;
  try {
    lst = lstatSync(candidate);
  } catch {
    lst = null;
  }

  if (lst) {
    if (lst.isSymbolicLink()) {
      let targetReal;
      try {
        targetReal = realpathSync(candidate);
      } catch {
        throw new PathError(403, `Registry symlink escapes ${rootLabel}`);
      }
      if (!isInsideDir(rootCanon, targetReal)) {
        throw new PathError(403, `Registry symlink escapes ${rootLabel}`);
      }
    }
    if (!statSync(candidate).isFile()) {
      throw new PathError(400, 'Registry target is not a regular file');
    }
  } else if (!allowMissing) {
    throw new PathError(404, notFoundMessage);
  }
  return candidate;
}

export function resolveRegistryTarget(
  wsReal,
  relPath,
  { allowMissing = false, dataDir = '', allowCustomRel = false } = {}
) {
  if (relPath === MANAGED_REGISTRY_VIRTUAL_REL) {
    if (!dataDir || typeof dataDir !== 'string') {
      throw new PathError(400, 'Plugin data directory is required for managed registry');
    }
    const dataRootReal = canonicalizeMissingRoot(dataDir);
    const managedCandidate = getManagedRegistryPath(dataRootReal, wsReal);
    return assertSafeTargetWithinRoot(dataRootReal, managedCandidate, {
      allowMissing,
      rootLabel: 'plugin_data',
    });
  }

  if (typeof relPath !== 'string') {
    throw new PathError(
      403,
      'Registry path must be one of .agents/SESSION-REGISTRY.md, research/SESSION-REGISTRY.md, or SESSION-REGISTRY.md'
    );
  }
  if (!ALLOWED_REGISTRY_SET.has(relPath)) {
    if (!allowCustomRel) {
      throw new PathError(
        403,
        'Registry path must be one of .agents/SESSION-REGISTRY.md, research/SESSION-REGISTRY.md, or SESSION-REGISTRY.md'
      );
    }
    validateCustomRegistryRelPath(relPath);
  }
  const candidate = resolve(wsReal, relPath);
  return assertSafeTargetWithinRoot(wsReal, candidate, { allowMissing, rootLabel: 'workspace' });
}

function readWorkspaceSettingsSafe(dataDir, wsReal) {
  if (!dataDir || !wsReal) return null;
  const settingsPath = join(getWorkspaceSettingsDir(dataDir, wsReal), 'settings.json');
  const raw = readJsonSafe(settingsPath, null);
  return raw && typeof raw === 'object' ? raw : null;
}

export function findExistingRegistry(wsReal, { dataDir = '', workspaceSettings = null } = {}) {
  if (!wsReal) return null;
  const wsCfg = workspaceSettings || readWorkspaceSettingsSafe(dataDir, wsReal);

  if (wsCfg?.registryMode === 'plugin_data' && dataDir) {
    const managedPath = getManagedRegistryPath(dataDir, wsReal);
    if (existsSync(managedPath)) {
      const target = resolveRegistryTarget(wsReal, MANAGED_REGISTRY_VIRTUAL_REL, {
        allowMissing: false,
        dataDir,
      });
      return { relPath: MANAGED_REGISTRY_VIRTUAL_REL, absPath: target, isManaged: true };
    }
  }

  if (wsCfg?.registryMode === 'workspace_custom' && wsCfg?.customRegistryRelPath) {
    try {
      const customRel = validateCustomRegistryRelPath(wsCfg.customRegistryRelPath);
      const customAbs = resolve(wsReal, customRel);
      if (existsSync(customAbs)) {
        const target = resolveRegistryTarget(wsReal, customRel, {
          allowMissing: false,
          allowCustomRel: true,
        });
        return { relPath: customRel, absPath: target, isManaged: false };
      }
    } catch (err) {
      if (err instanceof PathError && err.message.includes('symlink')) {
        throw err;
      }
    }
  }

  for (const relPath of REGISTRY_CANDIDATES) {
    const p = resolve(wsReal, relPath);
    if (existsSync(p)) {
      const target = resolveRegistryTarget(wsReal, relPath, { allowMissing: false });
      return { relPath, absPath: target, isManaged: false };
    }
  }

  if (dataDir) {
    const managedPath = getManagedRegistryPath(dataDir, wsReal);
    if (existsSync(managedPath)) {
      const target = resolveRegistryTarget(wsReal, MANAGED_REGISTRY_VIRTUAL_REL, {
        allowMissing: false,
        dataDir,
      });
      return { relPath: MANAGED_REGISTRY_VIRTUAL_REL, absPath: target, isManaged: true };
    }
  }

  return null;
}

export function findRegistryInWorkspaces(workspacePaths, { dataDir = '' } = {}) {
  if (!Array.isArray(workspacePaths)) return null;
  for (const raw of workspacePaths) {
    const wsReal = normalizeWorkspaceInput(raw, { throwOnInvalid: false });
    if (!wsReal) continue;
    try {
      const found = findExistingRegistry(wsReal, { dataDir });
      if (found) return { workspace: wsReal, ...found };
    } catch {
      continue;
    }
  }
  return null;
}

const LOCK_SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function withFileLockSync(lockPath, fn, { timeoutMs = 1500, staleMs = 10000 } = {}) {
  if (!lockPath) return fn();
  const parent = dirname(lockPath);
  mkdirSync(parent, { recursive: true });
  const token = `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const deadline = Date.now() + Math.max(50, timeoutMs);
  let acquired = false;

  while (Date.now() <= deadline) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now(), token }), 'utf8');
      } finally {
        closeSync(fd);
      }
      acquired = true;
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') break;
      const holder = readJsonSafe(lockPath, null);
      const now = Date.now();
      const isStale =
        !holder ||
        now - Number(holder.ts || 0) > staleMs ||
        (holder.pid && !isPidAlive(Number(holder.pid)));
      if (isStale) {
        try {
          unlinkSync(lockPath);
          continue;
        } catch {
          // raced with another cleaner
        }
      }
      try {
        Atomics.wait(LOCK_SLEEP_BUF, 0, 0, 8);
      } catch {
        break;
      }
    }
  }

  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        const cur = readJsonSafe(lockPath, null);
        if (!cur || cur.token === token) {
          unlinkSync(lockPath);
        }
      } catch {
        // ignore cleanup race
      }
    }
  }
}

export function atomicWriteText(targetPath, content) {
  let writeTarget = targetPath;
  try {
    if (lstatSync(targetPath).isSymbolicLink()) {
      writeTarget = realpathSync(targetPath);
    }
  } catch {
    // target does not exist yet
  }
  const parent = dirname(writeTarget);
  mkdirSync(parent, { recursive: true });
  const tmp = join(parent, `.tmp.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, writeTarget);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore orphan cleanup failure
    }
    throw err;
  }
}

export function readJsonSafe(filePath, fallback = null) {
  if (!filePath || !existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}
