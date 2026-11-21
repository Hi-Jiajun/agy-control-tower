import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  return resolve(env.HOME || homedir());
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

/**
 * Resolve candidate Antigravity app data directories (<appDataDir> containing brain/).
 */
export function resolveAppDataDirs({ env = process.env, hintPath = '' } = {}) {
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
    return list;
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
  return list;
}

/**
 * Resolve persistent plugin_data directory without creating it on read.
 */
export function resolvePluginDataDir({ env = process.env, hintPath = '' } = {}) {
  if (env.AGY_CONTROL_TOWER_DATA_DIR && env.AGY_CONTROL_TOWER_DATA_DIR.trim()) {
    return resolve(env.AGY_CONTROL_TOWER_DATA_DIR.trim());
  }
  if (env.PLUGIN_DATA && env.PLUGIN_DATA.trim()) {
    return resolve(env.PLUGIN_DATA.trim());
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

function assertSafeTargetWithinRoot(rootReal, candidate, { allowMissing = false, rootLabel = 'workspace' } = {}) {
  const rel = relative(rootReal, candidate);
  if (rel.startsWith('..') || rel.includes(`..${sep}`) || isAbsolute(rel)) {
    throw new PathError(403, 'Path traversal blocked');
  }

  const parent = dirname(candidate);
  if (existsSync(parent)) {
    const parentReal = realpathSync(parent);
    const parentRel = relative(rootReal, parentReal);
    if (parentRel.startsWith('..') || isAbsolute(parentRel)) {
      throw new PathError(403, `Parent symlink escapes ${rootLabel}`);
    }
  }

  if (existsSync(candidate)) {
    const lst = lstatSync(candidate);
    if (lst.isSymbolicLink()) {
      const targetReal = realpathSync(candidate);
      const tRel = relative(rootReal, targetReal);
      if (tRel.startsWith('..') || isAbsolute(tRel)) {
        throw new PathError(403, `Registry symlink escapes ${rootLabel}`);
      }
    }
    if (!statSync(candidate).isFile()) {
      throw new PathError(400, 'Registry target is not a regular file');
    }
  } else if (!allowMissing) {
    throw new PathError(404, 'SESSION-REGISTRY.md not found');
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
    const dataAbs = resolve(dataDir);
    const dataRootReal = existsSync(dataAbs) ? realpathSync(dataAbs) : dataAbs;
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

export function atomicWriteText(targetPath, content) {
  const parent = dirname(targetPath);
  mkdirSync(parent, { recursive: true });
  const tmp = join(parent, `.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`);
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, targetPath);
}

export function readJsonSafe(filePath, fallback = null) {
  if (!filePath || !existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}
