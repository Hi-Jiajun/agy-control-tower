import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  atomicWriteText,
  getWorkspaceSettingsDir,
  PathError,
  readJsonSafe,
  validateCustomRegistryRelPath,
} from './paths.mjs';

export const MAX_OVERRIDE_DOC_BYTES = 256 * 1024;
export const OVERRIDE_DOC_NAMES = ['model-routing.md', 'templates.md'];
const ALLOWED_OVERRIDE_SET = new Set(OVERRIDE_DOC_NAMES);

export const DEFAULT_PLUGIN_SETTINGS = Object.freeze({
  livePollEnabled: true,
  livePollIntervalSec: 4,
  uiMotion: 'standard',
  attentionBannerEnabled: true,
  dualRoleHookEnabled: true,
  registryWriteGuard: 'ask',
  stopHookReportEnabled: true,
  maxLookupInputLength: 2000,
  maxLookupCandidates: 6,
  sentinelEnabled: true,
  sentinelIntervalSec: 15,
  focusCooldownSec: 180,
  stuckThresholdMin: 15,
});

export const DEFAULT_GLOBAL_SETTINGS = Object.freeze({
  l0ControllerModel: 'Gemini 4 Neon (XHigh)',
  l1LightModel: 'Gemini 4 Hydrogen (XHigh)',
  l2StandardModel: 'Orchestrator (Neon Extra High)',
  l3DeepModel: 'Orchestrator (Carbon)',
  l4IntegrationModel: 'Orchestrator (Neon Extra High)',
  modelGuardPolicy: 'strict_gemini4',
  customAllowedModels: [],
  askBeforeDispatch: true,
  decisionAutonomy: 'inherit',
  notifyOnSingleTaskDone: false,
  controllerCompactionThreshold: 5,
  workerCompactionThreshold: 2,
  dispatchSurfacePolicy: 'hidden_first',
  autoLearnMode: 'smart_proposal',
});

export const DEFAULT_WORKSPACE_SETTINGS = Object.freeze({
  workspacePath: '',
  registryMode: 'workspace_auto',
  customRegistryRelPath: '',
  exclusiveLeaseEnabled: true,
  overrides: {},
});

export const OVERRIDABLE_GLOBAL_KEYS = Object.freeze(Object.keys(DEFAULT_GLOBAL_SETTINGS));
const OVERRIDABLE_GLOBAL_SET = new Set(OVERRIDABLE_GLOBAL_KEYS);

export const MODEL_PRESETS = Object.freeze([
  'Orchestrator (Neon Extra High)',
  'Orchestrator (Carbon)',
  'Orchestrator (Neon)',
  'Gemini 4 Neon (XHigh)',
  'Gemini 4 Hydrogen (XHigh)',
  'Gemini 4 Carbon (High)',
  'Gemini 4 Neon (High)',
  'Gemini 4 Hydrogen (High)',
  'Gemini 4 Carbon (Medium)',
  'Gemini 4 Neon (Medium)',
  'Gemini 4 Hydrogen (Medium)',
  'Gemini 4 Hydrogen (Low)',
]);

const MODEL_ALIAS_TO_AGENTAPI = new Map([
  ['orchestrator', 'gemini-pro-orchestrator-neon'],
  ['orchestrator (carbon)', 'gemini-pro-orchestrator'],
  ['orchestrator (carbon high)', 'gemini-pro-orchestrator'],
  ['orchestrator (carbon medium)', 'gemini-pro-orchestrator'],
  ['orchestrator (gemini 4 carbon high)', 'gemini-pro-orchestrator'],
  ['orchestrator (gemini 4 carbon medium)', 'gemini-pro-orchestrator'],
  ['orchestrator (neon)', 'gemini-pro-orchestrator-neon'],
  ['orchestrator (neon high)', 'gemini-pro-orchestrator-neon'],
  ['orchestrator (neon xhigh)', 'gemini-pro-orchestrator-neon'],
  ['orchestrator (neon extra high)', 'gemini-pro-orchestrator-neon'],
  ['orchestrator (gemini 4 neon high)', 'gemini-pro-orchestrator-neon'],
  ['orchestrator (gemini 4 neon xhigh)', 'gemini-pro-orchestrator-neon'],
  ['orchestrator (gemini 4 neon extra high)', 'gemini-pro-orchestrator-neon'],
  ['orchestrator (hydrogen)', 'gemini-4-hydrogen-high'],
  ['orchestrator (hydrogen high)', 'gemini-4-hydrogen-high'],
  ['orchestrator (hydrogen xhigh)', 'gemini-4-hydrogen-xhigh'],
  ['orchestrator (hydrogen extra high)', 'gemini-4-hydrogen-xhigh'],
  ['orchestrator (gemini 4 hydrogen high)', 'gemini-4-hydrogen-high'],
  ['orchestrator (gemini 4 hydrogen xhigh)', 'gemini-4-hydrogen-xhigh'],
  ['orchestrator (gemini 4 hydrogen extra high)', 'gemini-4-hydrogen-xhigh'],
  ['gemini 4 carbon tiered', 'gemini-4-carbon-high'],
  ['gemini 4 neon tiered', 'gemini-4-neon-xhigh'],
  ['gemini 4 hydrogen tiered', 'gemini-4-hydrogen-xhigh'],
  ['gemini 4 carbon (high)', 'gemini-4-carbon-high'],
  ['gemini 4 carbon high', 'gemini-4-carbon-high'],
  ['gemini 4 carbon (medium)', 'gemini-4-carbon-medium'],
  ['gemini 4 carbon medium', 'gemini-4-carbon-medium'],
  ['gemini 4 carbon (low)', 'gemini-4-carbon-low'],
  ['gemini 4 carbon low', 'gemini-4-carbon-low'],
  ['gemini 4 neon (xhigh)', 'gemini-4-neon-xhigh'],
  ['gemini 4 neon (extra high)', 'gemini-4-neon-xhigh'],
  ['gemini 4 neon extra high', 'gemini-4-neon-xhigh'],
  ['gemini 4 neon (high)', 'gemini-4-neon-high'],
  ['gemini 4 neon high', 'gemini-4-neon-high'],
  ['gemini 4 neon (medium)', 'gemini-4-neon-medium'],
  ['gemini 4 neon medium', 'gemini-4-neon-medium'],
  ['gemini 4 neon (low)', 'gemini-4-neon-low'],
  ['gemini 4 neon low', 'gemini-4-neon-low'],
  ['gemini 4 hydrogen (xhigh)', 'gemini-4-hydrogen-xhigh'],
  ['gemini 4 hydrogen (extra high)', 'gemini-4-hydrogen-xhigh'],
  ['gemini 4 hydrogen extra high', 'gemini-4-hydrogen-xhigh'],
  ['gemini 4 hydrogen (high)', 'gemini-4-hydrogen-high'],
  ['gemini 4 hydrogen high', 'gemini-4-hydrogen-high'],
  ['gemini 4 hydrogen (medium)', 'gemini-4-hydrogen-medium'],
  ['gemini 4 hydrogen medium', 'gemini-4-hydrogen-medium'],
  ['gemini 4 hydrogen (low)', 'gemini-4-hydrogen-low'],
  ['gemini 4 hydrogen low', 'gemini-4-hydrogen-low'],
]);

function clampInt(val, min, max, fallback) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  const i = Math.trunc(num);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function cleanModelString(val, fallback) {
  if (typeof val !== 'string') return fallback;
  const s = val.replace(/[\r\n]+/g, ' ').trim();
  if (!s) return fallback;
  return s.slice(0, 120);
}

function cleanModelArray(val) {
  if (!Array.isArray(val)) return [];
  const seen = new Set();
  const out = [];
  for (const item of val) {
    if (typeof item !== 'string') continue;
    const s = item.replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 40) break;
  }
  return out;
}

export function getPluginSettingsPath(dataDir) {
  return join(resolve(dataDir), 'plugin-settings.json');
}

export function getGlobalSettingsPath(dataDir) {
  return join(resolve(dataDir), 'global-settings.json');
}

export function getWorkspaceSettingsPath(dataDir, wsReal) {
  return join(getWorkspaceSettingsDir(dataDir, wsReal), 'settings.json');
}

export function getOverrideDocPath(dataDir, scope, docName, wsReal = '') {
  if (!ALLOWED_OVERRIDE_SET.has(docName)) {
    throw new PathError(400, `Unsupported override document: ${docName}`);
  }
  if (scope === 'global') {
    return join(resolve(dataDir), 'overrides', 'global', docName);
  }
  if (scope === 'workspace') {
    if (!wsReal) {
      throw new PathError(400, 'workspace is required for workspace override');
    }
    return join(getWorkspaceSettingsDir(dataDir, wsReal), 'overrides', docName);
  }
  throw new PathError(400, `Invalid override scope: ${scope}`);
}

export function sanitizePluginSettings(raw, base = DEFAULT_PLUGIN_SETTINGS) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const b = { ...DEFAULT_PLUGIN_SETTINGS, ...(base || {}) };
  return {
    livePollEnabled: typeof src.livePollEnabled === 'boolean' ? src.livePollEnabled : b.livePollEnabled,
    livePollIntervalSec:
      src.livePollIntervalSec !== undefined
        ? clampInt(src.livePollIntervalSec, 2, 60, b.livePollIntervalSec)
        : b.livePollIntervalSec,
    uiMotion: src.uiMotion === 'reduced' || src.uiMotion === 'standard' ? src.uiMotion : b.uiMotion,
    attentionBannerEnabled:
      typeof src.attentionBannerEnabled === 'boolean'
        ? src.attentionBannerEnabled
        : b.attentionBannerEnabled,
    dualRoleHookEnabled:
      typeof src.dualRoleHookEnabled === 'boolean' ? src.dualRoleHookEnabled : b.dualRoleHookEnabled,
    registryWriteGuard:
      src.registryWriteGuard === 'ask' || src.registryWriteGuard === 'deny' || src.registryWriteGuard === 'off'
        ? src.registryWriteGuard
        : b.registryWriteGuard,
    stopHookReportEnabled:
      typeof src.stopHookReportEnabled === 'boolean'
        ? src.stopHookReportEnabled
        : b.stopHookReportEnabled,
    maxLookupInputLength:
      src.maxLookupInputLength !== undefined
        ? clampInt(src.maxLookupInputLength, 100, 10000, b.maxLookupInputLength)
        : b.maxLookupInputLength,
    maxLookupCandidates:
      src.maxLookupCandidates !== undefined
        ? clampInt(src.maxLookupCandidates, 1, 20, b.maxLookupCandidates)
        : b.maxLookupCandidates,
    sentinelEnabled:
      typeof src.sentinelEnabled === 'boolean' ? src.sentinelEnabled : b.sentinelEnabled,
    sentinelIntervalSec:
      src.sentinelIntervalSec !== undefined
        ? clampInt(src.sentinelIntervalSec, 5, 300, b.sentinelIntervalSec)
        : b.sentinelIntervalSec,
    focusCooldownSec:
      src.focusCooldownSec !== undefined
        ? clampInt(src.focusCooldownSec, 30, 900, b.focusCooldownSec)
        : b.focusCooldownSec,
    stuckThresholdMin:
      src.stuckThresholdMin !== undefined
        ? clampInt(src.stuckThresholdMin, 5, 120, b.stuckThresholdMin)
        : b.stuckThresholdMin,
  };
}

function sanitizeGlobalField(key, val, fallback) {
  switch (key) {
    case 'l0ControllerModel':
    case 'l1LightModel':
    case 'l2StandardModel':
    case 'l3DeepModel':
    case 'l4IntegrationModel':
      return cleanModelString(val, fallback);
    case 'modelGuardPolicy':
      return val === 'strict_gemini4' || val === 'custom_allowlist' ? val : fallback;
    case 'customAllowedModels':
      return val !== undefined ? cleanModelArray(val) : [...fallback];
    case 'askBeforeDispatch':
    case 'notifyOnSingleTaskDone':
      return typeof val === 'boolean' ? val : fallback;
    case 'decisionAutonomy':
      return ['inherit', 'autonomous', 'balanced', 'strict'].includes(val) ? val : fallback;
    case 'controllerCompactionThreshold':
    case 'workerCompactionThreshold':
      return val !== undefined ? clampInt(val, 1, 20, fallback) : fallback;
    case 'dispatchSurfacePolicy':
      return ['hidden_first', 'slot_reuse', 'allow_toplevel'].includes(val) ? val : fallback;
    case 'autoLearnMode':
      return ['smart_proposal', 'milestone_only', 'off'].includes(val) ? val : fallback;
    default:
      return fallback;
  }
}

export function sanitizeGlobalSettings(raw, base = DEFAULT_GLOBAL_SETTINGS) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const b = { ...DEFAULT_GLOBAL_SETTINGS, ...(base || {}) };
  const out = {};
  for (const key of OVERRIDABLE_GLOBAL_KEYS) {
    out[key] = sanitizeGlobalField(key, src[key], b[key]);
  }
  return out;
}

export function sanitizeWorkspaceSettings(
  raw,
  wsReal = '',
  base = DEFAULT_WORKSPACE_SETTINGS,
  { strictCustomRel = false } = {}
) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const b = { ...DEFAULT_WORKSPACE_SETTINGS, ...(base || {}), overrides: { ...(base?.overrides || {}) } };
  const registryMode = ['workspace_auto', 'plugin_data', 'workspace_custom'].includes(src.registryMode)
    ? src.registryMode
    : b.registryMode;

  let customRegistryRelPath =
    typeof src.customRegistryRelPath === 'string'
      ? src.customRegistryRelPath.trim()
      : b.customRegistryRelPath;

  if (registryMode === 'workspace_custom') {
    if (customRegistryRelPath) {
      try {
        customRegistryRelPath = validateCustomRegistryRelPath(customRegistryRelPath);
      } catch (err) {
        if (strictCustomRel) throw err;
        customRegistryRelPath = '';
      }
    } else if (strictCustomRel) {
      throw new PathError(400, 'customRegistryRelPath is required for workspace_custom mode');
    }
  } else if (customRegistryRelPath) {
    try {
      customRegistryRelPath = validateCustomRegistryRelPath(customRegistryRelPath);
    } catch {
      customRegistryRelPath = '';
    }
  }

  const nextOverrides = { ...(b.overrides || {}) };
  if (src.overrides && typeof src.overrides === 'object') {
    for (const key of OVERRIDABLE_GLOBAL_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(src.overrides, key)) continue;
      const val = src.overrides[key];
      if (val === null || val === undefined) {
        delete nextOverrides[key];
      } else {
        nextOverrides[key] = sanitizeGlobalField(key, val, DEFAULT_GLOBAL_SETTINGS[key]);
      }
    }
  }
  for (const k of Object.keys(nextOverrides)) {
    if (!OVERRIDABLE_GLOBAL_SET.has(k)) delete nextOverrides[k];
  }

  return {
    workspacePath: wsReal || src.workspacePath || b.workspacePath || '',
    registryMode,
    customRegistryRelPath,
    exclusiveLeaseEnabled:
      typeof src.exclusiveLeaseEnabled === 'boolean'
        ? src.exclusiveLeaseEnabled
        : b.exclusiveLeaseEnabled,
    overrides: nextOverrides,
  };
}

export function loadPluginSettings(dataDir) {
  if (!dataDir) return { ...DEFAULT_PLUGIN_SETTINGS };
  const raw = readJsonSafe(getPluginSettingsPath(dataDir), null);
  return sanitizePluginSettings(raw, DEFAULT_PLUGIN_SETTINGS);
}

export function savePluginSettings(dataDir, patch) {
  const current = loadPluginSettings(dataDir);
  const next = sanitizePluginSettings(patch, current);
  atomicWriteText(getPluginSettingsPath(dataDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function resetPluginSettings(dataDir) {
  const next = { ...DEFAULT_PLUGIN_SETTINGS };
  atomicWriteText(getPluginSettingsPath(dataDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function loadGlobalSettings(dataDir) {
  if (!dataDir) return { ...DEFAULT_GLOBAL_SETTINGS, customAllowedModels: [] };
  const raw = readJsonSafe(getGlobalSettingsPath(dataDir), null);
  return sanitizeGlobalSettings(raw, DEFAULT_GLOBAL_SETTINGS);
}

export function saveGlobalSettings(dataDir, patch) {
  const current = loadGlobalSettings(dataDir);
  const next = sanitizeGlobalSettings(patch, current);
  atomicWriteText(getGlobalSettingsPath(dataDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function resetGlobalSettings(dataDir) {
  const next = { ...DEFAULT_GLOBAL_SETTINGS, customAllowedModels: [] };
  atomicWriteText(getGlobalSettingsPath(dataDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function loadWorkspaceSettings(dataDir, wsReal) {
  if (!dataDir || !wsReal) {
    return { ...DEFAULT_WORKSPACE_SETTINGS, workspacePath: wsReal || '', overrides: {} };
  }
  const raw = readJsonSafe(getWorkspaceSettingsPath(dataDir, wsReal), null);
  return sanitizeWorkspaceSettings(raw, wsReal, DEFAULT_WORKSPACE_SETTINGS, { strictCustomRel: false });
}

export function saveWorkspaceSettings(dataDir, wsReal, patch) {
  if (!wsReal) throw new PathError(400, 'workspace is required');
  const current = loadWorkspaceSettings(dataDir, wsReal);
  const next = sanitizeWorkspaceSettings(patch, wsReal, current, { strictCustomRel: true });
  atomicWriteText(getWorkspaceSettingsPath(dataDir, wsReal), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function resetWorkspaceSettings(dataDir, wsReal) {
  if (!wsReal) throw new PathError(400, 'workspace is required');
  const next = { ...DEFAULT_WORKSPACE_SETTINGS, workspacePath: wsReal, overrides: {} };
  atomicWriteText(getWorkspaceSettingsPath(dataDir, wsReal), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function readOverrideDoc(dataDir, scope, docName, wsReal = '') {
  if (!dataDir) return { exists: false, path: '', content: '' };
  if (scope === 'workspace' && !wsReal) return { exists: false, path: '', content: '' };
  const p = getOverrideDocPath(dataDir, scope, docName, wsReal);
  if (!existsSync(p)) return { exists: false, path: p, content: '' };
  try {
    return { exists: true, path: p, content: readFileSync(p, 'utf8') };
  } catch {
    return { exists: false, path: p, content: '' };
  }
}

export function saveDocOverride(dataDir, scope, docName, content, wsReal = '') {
  if (typeof content !== 'string') {
    throw new PathError(400, 'Override document content must be a string');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_OVERRIDE_DOC_BYTES) {
    throw new PathError(413, `${docName} override exceeds 256KB cap`);
  }
  const target = getOverrideDocPath(dataDir, scope, docName, wsReal);
  atomicWriteText(target, content.endsWith('\n') ? content : `${content}\n`);
  return { path: target, saved: true };
}

export function resetDocOverride(dataDir, scope, docName, wsReal = '') {
  const target = getOverrideDocPath(dataDir, scope, docName, wsReal);
  try {
    unlinkSync(target);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  return { path: target, reset: true };
}

export function readHostPermissionPolicy({ env = process.env } = {}) {
  const home = resolve(env.HOME || env.USERPROFILE || homedir());
  const cfgDir = env.AGY_CONFIG_DIR ? resolve(env.AGY_CONFIG_DIR) : join(home, '.gemini', 'config');
  const cfgPath = join(cfgDir, 'config.json');
  const raw = readJsonSafe(cfgPath, null);
  if (!raw || typeof raw !== 'object' || !raw.userSettings || typeof raw.userSettings !== 'object') {
    return { available: false, permissionPreset: '', autoExecutionPolicy: '' };
  }
  return {
    available: true,
    permissionPreset:
      typeof raw.userSettings.permissionPreset === 'string' ? raw.userSettings.permissionPreset : '',
    autoExecutionPolicy:
      typeof raw.userSettings.autoExecutionPolicy === 'string'
        ? raw.userSettings.autoExecutionPolicy
        : '',
  };
}

export function resolveEffectiveAutonomy(decisionAutonomy, hostPolicy) {
  const hostRaw = {
    permissionPreset: hostPolicy?.permissionPreset || '',
    autoExecutionPolicy: hostPolicy?.autoExecutionPolicy || '',
  };
  if (['autonomous', 'balanced', 'strict'].includes(decisionAutonomy)) {
    return { level: decisionAutonomy, source: 'configured', hostRaw };
  }
  const combined = `${hostRaw.permissionPreset} ${hostRaw.autoExecutionPolicy}`.trim();
  let level = 'balanced';
  if (/ALWAYS|TURBO|PROCEED_ALWAYS/i.test(combined)) {
    level = 'autonomous';
  } else if (/STRICT|REVIEW|DENY|ASK/i.test(combined)) {
    level = 'strict';
  }
  return { level, source: 'host_permission', hostRaw };
}

const builtinDocCache = new Map();

function readBuiltinDoc(pluginRoot, docName) {
  if (!pluginRoot) return { path: '', content: '' };
  const p = join(resolve(pluginRoot), 'skills', 'control-tower', 'references', docName);
  if (!existsSync(p)) return { path: p, content: '' };
  try {
    const mtimeMs = statSync(p).mtimeMs;
    const hit = builtinDocCache.get(p);
    if (hit && hit.mtimeMs === mtimeMs) {
      return { path: p, content: hit.content };
    }
    const content = readFileSync(p, 'utf8');
    builtinDocCache.set(p, { mtimeMs, content });
    return { path: p, content };
  } catch {
    return { path: p, content: '' };
  }
}

export function resolveEffectiveSettings({
  dataDir = '',
  wsReal = '',
  pluginRoot = '',
  env = process.env,
  includeDocs = true,
  preloadedPlugin = null,
  preloadedGlobal = null,
  preloadedHostPerm = null,
} = {}) {
  const plugin = preloadedPlugin || loadPluginSettings(dataDir);
  const global = preloadedGlobal || loadGlobalSettings(dataDir);
  const workspace = loadWorkspaceSettings(dataDir, wsReal);
  const hostPermission = preloadedHostPerm || readHostPermissionPolicy({ env });

  const effective = { ...global, customAllowedModels: [...global.customAllowedModels] };
  const sourceMap = {};
  for (const key of OVERRIDABLE_GLOBAL_KEYS) {
    if (wsReal && Object.prototype.hasOwnProperty.call(workspace.overrides, key)) {
      const val = workspace.overrides[key];
      effective[key] = Array.isArray(val) ? [...val] : val;
      sourceMap[key] = 'workspace';
    } else {
      sourceMap[key] = 'global';
    }
  }

  const autonomyResolved = resolveEffectiveAutonomy(effective.decisionAutonomy, hostPermission);
  effective.effectiveAutonomy = autonomyResolved.level;
  effective.autonomySource = autonomyResolved.source;
  effective.exclusiveLeaseEnabled = workspace.exclusiveLeaseEnabled;
  effective.registryMode = workspace.registryMode;
  effective.customRegistryRelPath = workspace.customRegistryRelPath;

  const docs = {};
  if (includeDocs) {
    for (const docName of OVERRIDE_DOC_NAMES) {
      const wsDoc = wsReal ? readOverrideDoc(dataDir, 'workspace', docName, wsReal) : { exists: false };
      const glDoc = readOverrideDoc(dataDir, 'global', docName);
      const builtinDoc = readBuiltinDoc(pluginRoot, docName);
      if (wsDoc.exists) {
        docs[docName] = {
          content: wsDoc.content,
          source: 'workspace',
          activePath: wsDoc.path,
          hasGlobalOverride: glDoc.exists,
          hasWorkspaceOverride: true,
          builtinContent: builtinDoc.content,
        };
      } else if (glDoc.exists) {
        docs[docName] = {
          content: glDoc.content,
          source: 'global',
          activePath: glDoc.path,
          hasGlobalOverride: true,
          hasWorkspaceOverride: false,
          builtinContent: builtinDoc.content,
        };
      } else {
        docs[docName] = {
          content: builtinDoc.content,
          source: 'builtin',
          activePath: builtinDoc.path,
          hasGlobalOverride: false,
          hasWorkspaceOverride: false,
          builtinContent: builtinDoc.content,
        };
      }
    }
  }

  return {
    plugin,
    global,
    workspace,
    effective,
    sourceMap,
    docs,
    hostPermission,
  };
}

export function validateDispatchModel(modelInput, effective = DEFAULT_GLOBAL_SETTINGS) {
  if (typeof modelInput !== 'string') {
    return { ok: false, reason: '模型参数缺失，请按路由配置显式指定 Gemini 4 / Orchestrator 模型。' };
  }
  const trimmed = modelInput.trim();
  if (!trimmed) {
    return { ok: false, reason: '模型参数为空，禁止按无模型默认路径新建会话。' };
  }
  const lower = trimmed.toLowerCase();

  if (lower === 'flash' || lower === 'flash_lite') {
    return {
      ok: false,
      reason: `control-tower 禁用默认低档快捷模型 (${trimmed})，请使用纯 Gemini 4 或 Orchestrator。`,
    };
  }
  if (/argon/i.test(trimmed)) {
    return { ok: false, reason: `control-tower 规则显式禁用 Argon 系列模型 (${trimmed})。` };
  }
  if (/(?:^|[^0-9])(3\.8|3\.7|3\.5|3\.0|2\.\d)/.test(lower)) {
    return { ok: false, reason: `control-tower 规则禁用旧代模型 (${trimmed})，仅限纯 Gemini 4 系列。` };
  }
  if (/carbon/i.test(trimmed) && !/orchestrator/i.test(trimmed) && /\b(xhigh|extra[\s_-]*high)\b/i.test(trimmed)) {
    return {
      ok: false,
      reason: `Gemini 4 Carbon 无 XHigh (Extra High) 档位 (${trimmed})，请选用 High 或 Medium。`,
    };
  }

  if (
    effective?.modelGuardPolicy === 'custom_allowlist' &&
    Array.isArray(effective.customAllowedModels) &&
    effective.customAllowedModels.some((m) => m.toLowerCase() === lower)
  ) {
    return { ok: true, model: trimmed, matchedBy: 'custom_allowlist' };
  }

  const isStrictGemini4 =
    /^(?:gemini[\s_-]*4[\s_-]*)?(?:carbon|neon|hydrogen)(?:[\s_-]*tiered)?(?:[\s_-]*\(?(?:low|medium|high|xhigh|extra[\s_-]*high)\)?|)?$/i.test(
      trimmed
    ) ||
    /^(?:gemini[\s_-]*pro[\s_-]*)?orchestrator(?:[\s_-]*\(?(?:(?:gemini[\s_-]*4[\s_-]*)?(?:carbon|neon|hydrogen))?(?:[\s_-]*(?:low|medium|high|xhigh|extra[\s_-]*high))?\)?|)?$/i.test(
      trimmed
    );
  if (isStrictGemini4) {
    return { ok: true, model: trimmed, matchedBy: 'gemini4' };
  }

  return {
    ok: false,
    reason: `模型 "${trimmed}" 不在当前纯 Gemini 4 + Orchestrator 允许范围内（可在设置中切换自定义白名单放行）。`,
  };
}

export function normalizeModelForAgentApi(modelInput) {
  const trimmed = typeof modelInput === 'string' ? modelInput.trim() : '';
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (MODEL_ALIAS_TO_AGENTAPI.has(lower)) {
    return MODEL_ALIAS_TO_AGENTAPI.get(lower);
  }
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    return trimmed;
  }
  return lower
    .replace(/[()]/g, ' ')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
