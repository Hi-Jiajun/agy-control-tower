#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findExistingRegistry,
  findRegistryInWorkspaces,
  normalizeWorkspaceInput,
  recordKnownWorkspace,
  resolvePluginDataDir,
  sha256,
} from '../lib/paths.mjs';
import {
  appendFlightEvent,
  SLOW_OP_THRESHOLD_MS,
} from '../lib/logger.mjs';
import {
  buildInboxDigestLine,
  cleanupWorkspaceInbox,
  clearDeferredReceipt,
  evaluateFocusGate,
  evaluateSentinelSweep,
  loadWorkspaceInbox,
  recordControllerFocus,
  setDeferredReceipt,
  upsertInboxItem,
} from '../lib/inbox.mjs';
import { loadWorkspaceRoadmap } from '../lib/roadmap.mjs';
import {
  findActiveWorkerSession,
  isActiveController,
  parseRegistry,
} from '../lib/registry.mjs';
import { resolveEffectiveSettings } from '../lib/settings.mjs';
import {
  extractFirstUserPromptRaw,
  extractPromptSessionIds,
  hasOutboundAgentApiReport,
  inspectById,
  inspectHiddenSurfaces,
  inspectNativeSwarm,
  inspectTranscript,
  isValidConvIdOrPrefix,
  loadPluginState,
  resolveBrainTranscript,
  stripSystemMessageEnvelope,
  updatePluginState,
} from '../lib/transcript.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const LEARN_CORRECTION_THROTTLE_MS = 15 * 60 * 1000;
const LEARN_MILESTONE_THROTTLE_MS = 15 * 60 * 1000;

function detectUserCorrectionSignal(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const trimmed = rawText.trim();
  if (!trimmed || trimmed.startsWith('/learn')) return false;
  const clean = trimmed
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .trim();
  if (!clean || clean.length > 1500) return false;
  return /(?:^|[\s，。！？,.;:：])(?:不对|错了|不要再|别再用|以后(?:必须|都|不要|别|统一)|记住(?:以后|这个|这条)?|踩坑|立个?规矩|改为|改成(?:这样|用)|不要擅自|下次(?:不要|别|记得)|always\s+remember|never\s+do\s+that|don'?t\s+do\s+that|stop\s+doing)/i.test(
    clean
  );
}

function hasNonEmptyLearnCandidate(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const m = rawText.match(/【?可沉淀经验候选】?\s*[：:]\s*([^\r\n]+)/);
  if (!m) return false;
  const val = m[1].trim().replace(/^[`"'*_\s]+|[`"'*_\s。.;；]+$/g, '');
  if (!val) return false;
  return !/^(?:无|暂无|无新经验|无新可复用经验|无新增|略|none|null|n\/a|-+|—+)$/i.test(val);
}

function readInstalledPluginVersion() {
  try {
    const raw = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'plugin.json'), 'utf8'));
    return typeof raw?.version === 'string' ? raw.version.trim() : '';
  } catch {
    return '';
  }
}

function readStdinSync() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function expandUserPath(raw) {
  if (typeof raw !== 'string') return '';
  let t = raw.replace(/[\u0000-\u001f]/g, '').trim();
  if (!t) return '';
  if (t.startsWith('file://')) {
    try {
      t = fileURLToPath(t);
    } catch {
      return '';
    }
  }
  const home = resolve(process.env.HOME || process.env.USERPROFILE || homedir());
  if (t === '~') return home;
  if (t.startsWith('~/') || t.startsWith('~\\')) {
    return resolve(home, t.slice(2));
  }
  return t;
}

function resolveCanonicalPath(rawPath, baseDir = '') {
  try {
    const expanded = expandUserPath(rawPath);
    if (!expanded) return '';
    const cleanBase = typeof baseDir === 'string' ? expandUserPath(baseDir) : '';
    const abs = isAbsolute(expanded)
      ? resolve(expanded)
      : resolve(cleanBase || process.cwd(), expanded);
    if (existsSync(abs)) {
      try {
        return realpathSync(abs);
      } catch {
        return abs;
      }
    }
    const parts = [];
    let cur = abs;
    for (let i = 0; i < 16; i += 1) {
      if (existsSync(cur)) {
        try {
          return join(realpathSync(cur), ...parts.reverse());
        } catch {
          return abs;
        }
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      parts.push(basename(cur));
      cur = parent;
    }
    return abs;
  } catch {
    return '';
  }
}

function resolveSelfTranscript(payload, convId, hintPath) {
  const tp = resolveCanonicalPath(payload.transcriptPath || '');
  if (tp && existsSync(tp)) return tp;
  const res = resolveBrainTranscript(convId, { hintPath });
  if (res.status === 'ok' && res.path) return res.path;
  return '';
}

function sameControllerId(a, b) {
  if (!a || !b) return false;
  const x = String(a).trim().toLowerCase();
  const y = String(b).trim().toLowerCase();
  return x === y || (x.length >= 8 && y.length >= 8 && (x.startsWith(y) || y.startsWith(x)));
}

function hasValidController(parsedReg) {
  const ctrlId = String(parsedReg?.controller?.currentControllerId || '').trim();
  return Boolean(ctrlId && isValidConvIdOrPrefix(ctrlId));
}

function upsertAttention(state, item) {
  const list = Array.isArray(state.pendingAttention) ? [...state.pendingAttention] : [];
  const idx = list.findIndex((x) => x && x.id === item.id);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...item };
  } else {
    list.push(item);
  }
  state.pendingAttention = list;
}

function canInvokeAgentApiInHook(env = process.env) {
  return Boolean(
    (env.ANTIGRAVITY_AGENTAPI_EXE && String(env.ANTIGRAVITY_AGENTAPI_EXE).trim()) ||
      (env.ANTIGRAVITY_LS_ADDRESS && String(env.ANTIGRAVITY_LS_ADDRESS).trim())
  );
}

function sendAgentApiMessage(recipientId, title, message) {
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  const isNodeScript = Boolean(exe && /\.m?js$/i.test(exe));
  const file = isNodeScript ? process.execPath : exe || 'agentapi';
  const baseArgs = ['send-message', '--title', title, recipientId, message];
  const args = isNodeScript
    ? [exe, 'agentapi', ...baseArgs]
    : exe
      ? ['agentapi', ...baseArgs]
      : baseArgs;
  execFileSync(file, args, {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const IGNORED_WRITE_KEYS = new Set([
  'path',
  'targetfile',
  'file',
  'target',
  'oldstring',
  'old_string',
  'oldtext',
  'old_text',
]);

function collectWriteStrings(node, out = [], depth = 0) {
  if (!node || depth > 6) return out;
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 32)) {
      collectWriteStrings(item, out, depth + 1);
    }
    return out;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (IGNORED_WRITE_KEYS.has(k.toLowerCase())) continue;
      collectWriteStrings(v, out, depth + 1);
    }
  }
  return out;
}

function toolArgsAssignControllerToSelf(args, convId) {
  if (!args || typeof args !== 'object' || !convId) return false;
  const full = String(convId).trim().toLowerCase();
  const short = full.slice(0, 8);
  const chunks = collectWriteStrings(args);
  if (chunks.length === 0) return false;
  const joined = chunks.join('\n');
  const lower = joined.toLowerCase();
  const hasSelfId = lower.includes(full) || (short.length >= 8 && lower.includes(short));
  if (!hasSelfId) return false;

  // Verify the written text actually updates Section 2 active controller to convId
  for (const line of joined.split(/\r?\n/)) {
    if (line.includes('当前现役总控会话')) {
      const lLower = line.toLowerCase();
      if (lLower.includes(full) || (short.length >= 8 && lLower.includes(short))) {
        return true;
      }
    }
  }
  const parsedCandidate = parseRegistry(joined);
  return isActiveController(convId, parsedCandidate);
}

function isKnownHiddenWorkerOfController(oldCtrlId, convId, hintPath) {
  if (!oldCtrlId || !convId) return false;
  try {
    const sw = inspectNativeSwarm(oldCtrlId, { hintPath });
    if (sw.active && sw.members.some((m) => m.conversationId && sameControllerId(m.conversationId, convId))) {
      return true;
    }
    const hid = inspectHiddenSurfaces(oldCtrlId, { hintPath });
    if (hid.subagents.some((s) => s.conversationId && sameControllerId(s.conversationId, convId))) {
      return true;
    }
  } catch {
    // ignore telemetry error
  }
  return false;
}

function isLegitimateHandoverTakeover({
  payload,
  regFound,
  parsedReg,
  dataDir,
  hintPath,
  convId,
  writePayload,
}) {
  // 1) Never allow enrolled active top-level workers or hidden Swarm/subagent workers to self-promote
  const enrolledWorker = findActiveWorkerSession(convId, parsedReg);
  if (enrolledWorker && String(enrolledWorker.status || '').toUpperCase() !== 'DONE') {
    return { allowed: false, reason: 'enrolled_worker' };
  }
  const oldCtrlId = String(parsedReg?.controller?.currentControllerId || '').trim();
  if (oldCtrlId && isKnownHiddenWorkerOfController(oldCtrlId, convId, hintPath)) {
    return { allowed: false, reason: 'hidden_surface_worker' };
  }

  // 2) Must actually be assigning Section 2 active controller to its own conversationId
  const args =
    writePayload !== undefined
      ? writePayload
      : payload?.toolCall?.args && typeof payload.toolCall.args === 'object'
        ? payload.toolCall.args
        : {};
  if (!toolArgsAssignControllerToSelf(args, convId)) {
    return { allowed: false, reason: 'missing_self_controller_assignment' };
  }

  // 3a) Pre-registered successor from Sidecar one-click handover
  const wsHash = sha256(regFound.workspace).slice(0, 16);
  const state = loadPluginState(dataDir);
  const pending = state.pendingSuccessors?.[wsHash];
  if (pending?.convId && sameControllerId(pending.convId, convId)) {
    return { allowed: true, reason: 'pre_registered_successor', wsHash };
  }

  // 3b) Manual handover card: stripped user prompt contains handover intent + outgoing controller ID
  const selfTp = resolveSelfTranscript(payload, convId, hintPath);
  if (oldCtrlId) {
    const candidatePrompts = [];
    if (selfTp) {
      const firstRaw = extractFirstUserPromptRaw(selfTp, 4000);
      if (firstRaw) candidatePrompts.push(stripSystemMessageEnvelope(firstRaw));
    }
    if (typeof payload.lastUserInput === 'string' && payload.lastUserInput.trim()) {
      candidatePrompts.push(stripSystemMessageEnvelope(payload.lastUserInput).slice(0, 4000));
    }

    const oldLower = oldCtrlId.toLowerCase();
    const oldPrefix = oldLower.slice(0, 8);
    for (const promptText of candidatePrompts) {
      if (!promptText) continue;
      const lowerPrompt = promptText.toLowerCase();
      const mentionsOldCtrl =
        lowerPrompt.includes(oldLower) || (oldPrefix.length >= 8 && lowerPrompt.includes(oldPrefix));
      const hasHandoverIntent =
        /常驻主交流总控|control-tower|chief-of-staff/i.test(promptText) &&
        /接班|换届|前任总控|handover/i.test(promptText);
      if (mentionsOldCtrl && hasHandoverIntent) {
        return { allowed: true, reason: 'handover_card_verified', wsHash };
      }
    }
  }

  return { allowed: false, reason: 'unverified_non_controller' };
}

function runThrottledHookSentinel(regFound, parsedReg, resolved, dataDir, hintPath, cacheMap = null) {
  if (resolved.plugin.sentinelEnabled === false) return false;
  const activeSessions = parsedReg.activeSessions || [];
  const ctrlId = String(parsedReg?.controller?.currentControllerId || '').trim();
  if (activeSessions.length === 0 && !ctrlId) return false;

  const inbox = loadWorkspaceInbox(dataDir, regFound.workspace);
  const intervalMs = Math.max(15, Number(resolved.plugin.sentinelIntervalSec || 15)) * 1000;
  const nowMs = Date.now();
  if (inbox.lastSweepAt > 0 && nowMs - inbox.lastSweepAt < intervalMs) {
    return false;
  }

  let cacheTouched = false;
  const prevKeys = cacheMap ? Object.keys(cacheMap).length : 0;
  try {
    const enrichedActive = activeSessions.map((s) => ({
      ...s,
      telemetry: s.conversationId ? inspectById(s.conversationId, { hintPath, cacheMap }) : null,
    }));
    const nativeSwarm = ctrlId ? inspectNativeSwarm(ctrlId, { hintPath, cacheMap }) : null;
    const hidden = ctrlId ? inspectHiddenSurfaces(ctrlId, { hintPath, cacheMap }) : { subagents: [] };
    if (cacheMap && Object.keys(cacheMap).length !== prevKeys) {
      cacheTouched = true;
    }
    if (enrichedActive.length === 0 && !nativeSwarm?.active && hidden.subagents.length === 0) {
      return cacheTouched;
    }

    evaluateSentinelSweep({
      dataDir,
      wsReal: regFound.workspace,
      activeControllerId: ctrlId,
      activeSessions: enrichedActive,
      nativeSwarm,
      subagents: hidden.subagents,
      workerCompactionThreshold: resolved.effective.workerCompactionThreshold || 2,
      stuckThresholdMin: resolved.plugin.stuckThresholdMin || 15,
      nowMs,
    });
  } catch {
    // keep hook resilient
  }
  return cacheTouched;
}

const APPLY_EDITS_TOOL_RE = /(?:^|[_:./-])apply_edits$/i;
const BUILTIN_WRITE_TOOL_RE = /^(?:write_file|edit_file)$/i;

function parseMaybeJsonValue(raw) {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function unwrapPreToolCall(toolCall) {
  const rawName = String(toolCall?.name || '').trim();
  const rawArgs =
    toolCall?.args && typeof toolCall.args === 'object' && !Array.isArray(toolCall.args)
      ? toolCall.args
      : {};

  if (rawName.toLowerCase() === 'call_mcp_tool') {
    const innerTool = String(rawArgs.ToolName || rawArgs.toolName || '').trim();
    if (!APPLY_EDITS_TOOL_RE.test(innerTool)) {
      return {
        kind: 'ignore',
        rawName,
        resolvedName: innerTool ? `${rawName}:${innerTool}` : rawName,
        toolArgs: {},
      };
    }
    const rawInnerArgs = rawArgs.Arguments ?? rawArgs.arguments;
    let parsedInnerArgs = {};
    if (typeof rawInnerArgs === 'string') {
      const parsed = parseMaybeJsonValue(rawInnerArgs);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedInnerArgs = parsed;
      } else {
        parsedInnerArgs = { edits: rawInnerArgs };
      }
    } else if (rawInnerArgs && typeof rawInnerArgs === 'object' && !Array.isArray(rawInnerArgs)) {
      parsedInnerArgs = rawInnerArgs;
    }
    return {
      kind: 'apply_edits',
      rawName,
      resolvedName: `${rawName}:${innerTool}`,
      toolArgs: parsedInnerArgs,
    };
  }

  if (APPLY_EDITS_TOOL_RE.test(rawName)) {
    return {
      kind: 'apply_edits',
      rawName,
      resolvedName: rawName,
      toolArgs: rawArgs,
    };
  }

  if (!rawName || BUILTIN_WRITE_TOOL_RE.test(rawName)) {
    return {
      kind: 'builtin_write',
      rawName,
      resolvedName: rawName,
      toolArgs: rawArgs,
    };
  }

  if (rawArgs.edits !== undefined) {
    return {
      kind: 'apply_edits',
      rawName,
      resolvedName: rawName,
      toolArgs: rawArgs,
    };
  }

  return {
    kind: 'builtin_write',
    rawName,
    resolvedName: rawName,
    toolArgs: rawArgs,
  };
}

function normalizeApplyEditEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    const rawPath = entry.trim();
    return rawPath ? { rawPath, writePayload: {} } : null;
  }
  if (typeof entry === 'object' && !Array.isArray(entry)) {
    const rawPath = String(
      entry.path ?? entry.Path ?? entry.TargetFile ?? entry.file ?? ''
    ).trim();
    if (!rawPath) return null;
    let writePayload = entry;
    if (typeof entry.hunks === 'string') {
      const parsedHunks = parseMaybeJsonValue(entry.hunks);
      if (Array.isArray(parsedHunks)) {
        writePayload = { ...entry, hunks: parsedHunks };
      }
    }
    return { rawPath, writePayload };
  }
  return null;
}

function extractApplyEditEntries(rawEdits) {
  const results = [];
  if (Array.isArray(rawEdits)) {
    for (const item of rawEdits.slice(0, 100)) {
      const norm = normalizeApplyEditEntry(item);
      if (norm) results.push(norm);
    }
    return results;
  }
  if (typeof rawEdits === 'string') {
    const parsed = parseMaybeJsonValue(rawEdits);
    if (Array.isArray(parsed)) {
      for (const item of parsed.slice(0, 100)) {
        const norm = normalizeApplyEditEntry(item);
        if (norm) results.push(norm);
      }
      return results;
    }
    if (parsed && typeof parsed === 'object') {
      const norm = normalizeApplyEditEntry(parsed);
      if (norm) results.push(norm);
      return results;
    }
    // Fallback regex extraction for malformed JSON string payloads
    const pathRe = /["'](?:path|Path|TargetFile|file)["']\s*:\s*"((?:[^"\\]|\\.)+)"/g;
    let m;
    while ((m = pathRe.exec(rawEdits)) !== null && results.length < 100) {
      let decoded = m[1];
      try {
        decoded = JSON.parse(`"${m[1]}"`);
      } catch {
        // keep raw capture
      }
      const rawPath = String(decoded || '').trim();
      if (rawPath) {
        results.push({ rawPath, writePayload: {} });
      }
    }
    return results;
  }
  if (rawEdits && typeof rawEdits === 'object') {
    const norm = normalizeApplyEditEntry(rawEdits);
    if (norm) results.push(norm);
  }
  return results;
}

function extractPreToolWriteTargets(unwrapped) {
  const args = unwrapped?.toolArgs || {};
  if (unwrapped?.kind === 'apply_edits') {
    const entries = extractApplyEditEntries(args.edits);
    if (entries.length > 0) return entries;
  }
  const fallbackPath = String(
    args.Path ?? args.TargetFile ?? args.path ?? args.file ?? ''
  ).trim();
  if (fallbackPath) {
    return [{ rawPath: fallbackPath, writePayload: args }];
  }
  return [];
}

function resolveEffectiveBaseDir(payloadCwd, argsCwd, fallbackWs = '') {
  const base =
    (typeof payloadCwd === 'string' && payloadCwd.trim()) ||
    (typeof fallbackWs === 'string' && fallbackWs.trim()) ||
    '';
  if (typeof argsCwd === 'string' && argsCwd.trim()) {
    return resolveCanonicalPath(argsCwd.trim(), base) || argsCwd.trim();
  }
  return base;
}

function evaluatePreToolUse({
  payload,
  regFound,
  parsedReg,
  resolved,
  dataDir,
  hintPath,
  convId,
  unwrapped,
  hitTargets,
}) {
  const guardMode = resolved.plugin.registryWriteGuard || 'ask';
  if (guardMode === 'off') {
    return { decision: 'allow' };
  }

  if (!Array.isArray(hitTargets) || hitTargets.length === 0) {
    return { decision: 'allow' };
  }

  const writePayload =
    unwrapped?.kind === 'builtin_write'
      ? hitTargets[0]?.writePayload || {}
      : hitTargets.map((t) => t.writePayload);

  if (!hasValidController(parsedReg) || isActiveController(convId, parsedReg)) {
    if (!hasValidController(parsedReg) && toolArgsAssignControllerToSelf(writePayload, convId)) {
      try {
        const curVer = readInstalledPluginVersion();
        if (curVer) {
          updatePluginState(dataDir, (st) => {
            st.controllers[convId] = {
              ...(st.controllers[convId] || {}),
              lastSyncedVersion: curVer,
              updatedAt: Date.now(),
            };
          });
          recordKnownWorkspace(dataDir, regFound.workspace);
        }
      } catch {
        // ignore
      }
    }
    return { decision: 'allow' };
  }

  // Double-evidence legitimate handover takeover check
  const takeover = isLegitimateHandoverTakeover({
    payload,
    regFound,
    parsedReg,
    dataDir,
    hintPath,
    convId,
    writePayload,
  });
  if (takeover.allowed) {
    try {
      const curVer = readInstalledPluginVersion();
      const nowMs = Date.now();
      updatePluginState(dataDir, (st) => {
        st.controllers[convId] = {
          ...(st.controllers[convId] || {}),
          lastSyncedVersion: curVer || st.controllers[convId]?.lastSyncedVersion || '',
          updatedAt: nowMs,
        };
        if (takeover.wsHash && st.pendingSuccessors?.[takeover.wsHash]) {
          st.pendingSuccessors[takeover.wsHash] = {
            ...st.pendingSuccessors[takeover.wsHash],
            activatedAt: st.pendingSuccessors[takeover.wsHash].activatedAt || nowMs,
          };
        }
      });
      cleanupWorkspaceInbox(dataDir, regFound.workspace, { activeControllerId: convId });
      recordKnownWorkspace(dataDir, regFound.workspace);
    } catch {
      // ignore state sync error during takeover
    }
    appendFlightEvent(dataDir, {
      level: 'info',
      source: 'hook',
      event: 'handover_takeover_allowed',
      ok: true,
      conv: convId,
      message: `Allowed legitimate controller handover (${takeover.reason}) on ${regFound.relPath}`,
      detail: { reason: takeover.reason, relPath: regFound.relPath },
    });
    return { decision: 'allow' };
  }

  const decision = guardMode === 'deny' ? 'deny' : 'ask';
  appendFlightEvent(dataDir, {
    level: 'warn',
    source: 'hook',
    event: 'write_guard_triggered',
    ok: false,
    conv: convId,
    message: `PreToolUse ${decision} on ${regFound.relPath}`,
    detail: {
      decision,
      reason: takeover.reason,
      toolName: unwrapped?.resolvedName || payload?.toolCall?.name || '',
      relPath: regFound.relPath,
    },
  });
  const reason =
    `[control-tower 台账写保护] SESSION-REGISTRY.md 已由现役总控会话接管，` +
    `当前会话非现役总控。如需入账或换届，请由现役总控更新或在 Control Tower 看板操作。`;
  return { decision, reason };
}

function handleSessionStart(regFound, parsedReg, resolved, dataDir, convId) {
  const isCtrl = isActiveController(convId, parsedReg);
  if (isCtrl) {
    const leaseStatus = ((parsedReg.lease || {}).lockStatus || '未知').trim();
    const activeCount = (parsedReg.activeSessions || []).length;
    const lockText =
      resolved.effective.exclusiveLeaseEnabled === false
        ? '无独占资源模式'
        : `独占锁状态: ${leaseStatus}`;
    const regTag = regFound.isManaged ? `${regFound.absPath} (PLUGIN_DATA 零侵入托管)` : regFound.absPath;

    const overrideNotes = [];
    if (resolved.docs['model-routing.md']?.source && resolved.docs['model-routing.md'].source !== 'builtin') {
      overrideNotes.push(
        `路由覆盖(${resolved.docs['model-routing.md'].source}): ${resolved.docs['model-routing.md'].activePath}`
      );
    }
    if (resolved.docs['templates.md']?.source && resolved.docs['templates.md'].source !== 'builtin') {
      overrideNotes.push(
        `模板覆盖(${resolved.docs['templates.md'].source}): ${resolved.docs['templates.md'].activePath}`
      );
    }
    const overrideSuffix = overrideNotes.length > 0 ? ` | ${overrideNotes.join(' | ')}` : '';
    let roadmapSuffix = '';
    try {
      const rm = loadWorkspaceRoadmap(regFound.workspace, {
        dataDir,
        workspaceSettings: resolved.workspace,
      });
      if (rm.exists && rm.graph) {
        const readyLabel = rm.graph.readyIds.slice(0, 4).join(', ') || '无';
        const overlapLabel =
          rm.graph.overlaps.length > 0 ? ` | 所有权冲突预警: ${rm.graph.overlaps.length} 组` : '';
        const nsLabel = rm.northStarBrief ? ` | 北极星: ${rm.northStarBrief.slice(0, 80)}` : '';
        roadmapSuffix =
          ` | 路线图(${rm.isManaged ? '托管' : '工作区'}): ${rm.graph.counts.done}/${rm.graph.counts.total} 完成` +
          ` | 就绪可并行分支: ${readyLabel}${overlapLabel}${nsLabel}`;
      }
    } catch {
      // ignore roadmap read error in SessionStart
    }
    const schemaIssues = [];
    if (resolved.effective.exclusiveLeaseEnabled !== false && !((parsedReg.lease || {}).lockStatus || '').trim()) {
      schemaIssues.push('第 1 节未匹配标准独占资源租约结构');
    }
    if ((parsedReg.activeSessions || []).some((s) => !s.conversationId)) {
      schemaIssues.push('第 3 节存在无有效会话 ID 的占位行');
    }
    const schemaHint =
      schemaIssues.length > 0
        ? ` | 台账格式提示: ${schemaIssues.join('；')}，建议按 control-tower 标准模板对齐`
        : '';
    const surfacePolicy = resolved.effective.dispatchSurfacePolicy || 'hidden_first';
    const askDispatchFlag = resolved.effective.askBeforeDispatch !== false ? '开' : '关';
    const learnMode = resolved.effective.autoLearnMode || 'smart_proposal';
    const msg =
      `[control-tower 总控就位] 已核验当前会话为工作区现役总控。` +
      `台账: ${regTag} | ${lockText} | 活跃专职会话: ${activeCount} 个 | ` +
      `派遣策略: ${surfacePolicy} (派前确认: ${askDispatchFlag}) | ` +
      `自动学习: ${learnMode} | ` +
      `代决策档位: ${resolved.effective.effectiveAutonomy} (${resolved.effective.autonomySource}) | ` +
      `换届阈值: ${resolved.effective.controllerCompactionThreshold} 次压缩` +
      `${roadmapSuffix}${overrideSuffix}${schemaHint}。`;
    process.stdout.write(
      `${JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: msg } }] })}\n`
    );
    return;
  }

  if (resolved.plugin.dualRoleHookEnabled === false) {
    process.stdout.write('{}\n');
    return;
  }

  const workerRow = findActiveWorkerSession(convId, parsedReg);
  if (!workerRow || String(workerRow.status || '').toUpperCase() === 'DONE') {
    process.stdout.write('{}\n');
    return;
  }

  const ctrlId = String(parsedReg?.controller?.currentControllerId || '').trim();
  const lockDesc =
    resolved.effective.exclusiveLeaseEnabled === false
      ? '无独占资源模式'
      : workerRow.lockStatus || '纯离线无锁';
  const reportHint = hasValidController(parsedReg)
    ? `遇到需拍板分叉或完成收口时，请通过 agentapi send-message "${ctrlId}" "[CT_REPORT:DECISION] ..." 或 "[CT_REPORT:DONE] [<任务或分支ID>] <交付摘要> | 【可沉淀经验候选】：<1~3行或无>" 向总控汇报。`
    : '完成收口后请输出清晰交付清单与验证输出供总控入账。';
  const workerMsg =
    `[control-tower 专职会话约束] 任务: ${workerRow.topic || '-'} | 资源边界: ${lockDesc} | ` +
    `严禁直接修改 ${regFound.relPath}（由总控或看板独占写入），严禁私改 AGENTS.md / .agents/rules/ 与技能文件；完工可附 1~3 行经验候选（无则写无）。${reportHint}`;
  process.stdout.write(
    `${JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: workerMsg } }] })}\n`
  );
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesRoadmapNodeId(text, nodeId) {
  if (!text || !nodeId) return false;
  const re = new RegExp(`(?:^|[^A-Za-z0-9_-])${escapeRegExp(nodeId)}(?=$|[^A-Za-z0-9_-])`, 'i');
  return re.test(text);
}

function handlePreInvocation(payload, regFound, parsedReg, resolved, dataDir, hintPath, convId) {
  if (!isActiveController(convId, parsedReg)) {
    process.stdout.write('{}\n');
    return;
  }

  const state = loadPluginState(dataDir);
  const touchedCacheKeys = new Set();
  const deferredCompletedIds = [];
  const injectSteps = [];
  const lastInput = String(payload.lastUserInput || '');
  const strippedInput = stripSystemMessageEnvelope(lastInput);
  const autoLearnMode = resolved.effective.autoLearnMode || 'smart_proposal';
  let hasDeferredReceiptInjected = false;
  let learnCheckpointInjected = false;
  const isAutomatedInbound =
    lastInput.includes('[CT_AUTO_RECEIPT]') ||
    lastInput.includes('[CT_REPORT:') ||
    lastInput.includes('[CT_ROADMAP_DISPATCH]') ||
    lastInput.includes('[CT_SWARM_CLEANUP]') ||
    lastInput.includes('[CT_INBOX_DELIVER]');

  // Capture any queued/deferred Stop receipt BEFORE recordControllerFocus clears it
  const priorInbox = existsSync(dataDir) ? loadWorkspaceInbox(dataDir, regFound.workspace) : null;
  if (
    !isAutomatedInbound &&
    priorInbox?.deferredReceipt &&
    (!priorInbox.deferredReceipt.controllerId ||
      sameControllerId(priorInbox.deferredReceipt.controllerId, convId))
  ) {
    injectSteps.push({
      systemMessage: {
        systemMessage: `[control-tower 待收阶段回执] ${priorInbox.deferredReceipt.message}`,
      },
    });
    hasDeferredReceiptInjected = true;
    for (const cid of priorInbox.deferredReceipt.completedIds || []) {
      if (cid) deferredCompletedIds.push(cid);
    }
    try {
      clearDeferredReceipt(dataDir, regFound.workspace);
      appendFlightEvent(dataDir, {
        level: 'info',
        source: 'hook',
        event: 'deferred_receipt_injected',
        conv: convId,
        message: 'Injected queued Stop receipt into controller PreInvocation',
      });
    } catch {
      // ignore clear error
    }
  }

  // Record foreground focus state on genuine user turns (never mark automated receipts as foreground chat)
  if (!isAutomatedInbound && lastInput.trim()) {
    try {
      recordControllerFocus(dataDir, regFound.workspace, {
        controllerId: convId,
        inFlight: true,
        lastUserInputAt: Date.now(),
        clearDeferredReceipt: true,
      });
    } catch {
      // ignore focus write errors
    }
  }

  // 1) Intake routing: Stage receipt vs Board directives vs Decision/Done reports vs Bare/Multi-ID lookup
  if (lastInput.includes('[CT_AUTO_RECEIPT]')) {
    const receiptNote =
      `[control-tower 阶段收口指引] 已收到专职会话自动阶段回执，请核查尾步与交付清单、同步更新 ${regFound.absPath}，` +
      `并在全部阶段任务收口后向用户输出整理好的成果汇总并结束回合以触发 Antigravity 原生系统通知（严禁使用外部桌面通知命令）。`;
    injectSteps.push({ systemMessage: { systemMessage: receiptNote } });
  } else {
    if (lastInput.includes('[CT_ROADMAP_DISPATCH]')) {
      injectSteps.push({
        systemMessage: {
          systemMessage:
            `[control-tower 看板路线图派单] 用户已在看板显式点击隐藏面派单授权（免除重复 ask_question），` +
            `请核对文件所有权无未解冲突后直接按契约通过原生 swarm 或 invoke_subagent 拉起执行。`,
        },
      });
    } else if (lastInput.includes('[CT_SWARM_CLEANUP]')) {
      injectSteps.push({
        systemMessage: {
          systemMessage:
            `[control-tower Swarm 回收安全红线] 调用 swarm(action="kill") 会永久删除 share/branch 工作树，` +
            `执行前请先核查目标休眠成员无未合流代码或未落盘 .agents/handoffs/ 契约。`,
        },
      });
    } else if (lastInput.includes('[CT_INBOX_DELIVER]')) {
      injectSteps.push({
        systemMessage: {
          systemMessage: `[control-tower 收件箱投递] 请按 P0/P1/P2 优先级逐项处置以下看板投递事件并同步更新台账。`,
        },
      });
    } else if (lastInput.includes('[CT_REPORT:DECISION]')) {
      const level = resolved.effective.effectiveAutonomy;
      const decisionNote =
        `[control-tower 代决策指引] 当前生效代决策档位: ${level} (${resolved.effective.autonomySource})。` +
        `autonomous 档可直接用 agentapi send-message 自动拍板回复专职会话；balanced 档在局部细节内自决，涉及接口/架构分叉、范围变更或连续失败请调用 ask_question 通知用户；strict 档一律通过 ask_question 交由用户决定。`;
      injectSteps.push({ systemMessage: { systemMessage: decisionNote } });
      const cleanSummary = (strippedInput || lastInput).replace(/\s+/g, ' ').trim().slice(0, 140);
      try {
        upsertInboxItem(dataDir, regFound.workspace, {
          dedupKey: `decision:${cleanSummary.slice(0, 48)}`,
          priority: 'P0',
          kind: 'decision',
          source: 'worker',
          convId,
          title: '专职会话请求分叉拍板',
          summary: cleanSummary,
        });
      } catch {
        // ignore inbox error
      }
    } else if (lastInput.includes('[CT_REPORT:DONE]')) {
      const cleanSummary = (strippedInput || lastInput).replace(/\s+/g, ' ').trim().slice(0, 140);
      try {
        upsertInboxItem(dataDir, regFound.workspace, {
          dedupKey: `done:${cleanSummary.slice(0, 48)}`,
          priority: 'P2',
          kind: 'worker_done',
          source: 'worker',
          convId,
          title: '收到专职会话完成汇报',
          summary: cleanSummary,
        });
      } catch {
        // ignore inbox error
      }
      try {
        const rm = loadWorkspaceRoadmap(regFound.workspace, {
          dataDir,
          workspaceSettings: resolved.workspace,
        });
        if (rm.exists && rm.graph) {
          const activeNodes = rm.graph.nodes.filter((n) => n.effectiveStatus === 'active');
          const matchedNodes = activeNodes.filter(
            (n) =>
              (n.linkedConvId && lastInput.toLowerCase().includes(n.linkedConvId.slice(0, 8).toLowerCase())) ||
              matchesRoadmapNodeId(strippedInput || lastInput, n.id)
          );
          if (matchedNodes.length > 0) {
            injectSteps.push({
              systemMessage: {
                systemMessage: `[control-tower 路线图联动] 本次完成汇报关联活跃分支 ${matchedNodes
                  .map((n) => `${n.id}(${n.title})`)
                  .join('、')}，核验通过后可在看板或 roadmap.json 标记 done 以解锁下游并行分支。`,
              },
            });
          }
        }
      } catch {
        // ignore roadmap check error
      }
    } else {
      // Throttled zero-token sentinel sweep + single-source inbox cleanup
      const sentinelCached = runThrottledHookSentinel(
        regFound,
        parsedReg,
        resolved,
        dataDir,
        hintPath,
        state.transcriptCache
      );
      if (sentinelCached) {
        for (const k of Object.keys(state.transcriptCache)) touchedCacheKeys.add(k);
      }
      const handoverIgnored = Boolean(state.controllers[convId]?.handoverIgnored);
      const inbox = cleanupWorkspaceInbox(dataDir, regFound.workspace, {
        activeControllerId: convId,
        handoverIgnored,
      });
      const digestLine = buildInboxDigestLine(inbox);
      if (digestLine) {
        injectSteps.push({ systemMessage: { systemMessage: digestLine } });
      }
    }

    const knownIds = (parsedReg.activeSessions || [])
      .map((s) => s.conversationId)
      .filter(Boolean);
    const { ids } = extractPromptSessionIds(strippedInput || lastInput, {
      maxCandidates: resolved.plugin.maxLookupCandidates,
      maxInputLength: resolved.plugin.maxLookupInputLength,
      knownIds,
    });
    for (const cand of ids) {
      if (sameControllerId(cand, convId)) continue;
      const found = resolveBrainTranscript(cand, { hintPath });
      if (found.status === 'ok' && found.path) {
        const prevCache = state.transcriptCache[found.path] || null;
        const { info, nextCacheEntry } = inspectTranscript(found.path, { cacheEntry: prevCache });
        if (nextCacheEntry && nextCacheEntry !== prevCache) {
          state.transcriptCache[found.path] = nextCacheEntry;
          touchedCacheKeys.add(found.path);
        }
        const stepLabel = info.maxStepIndex || info.lineCount;
        const goal = info.goal || '(未捕获首条用户输入)';
        const model = info.lastModel || '未知';
        const updated = info.lastUpdatedAt || '未知';
        const st = info.lastStatus || '未知';
        const err = info.lastError ? ` | 最近报错: ${info.lastError}` : '';
        const note =
          `[control-tower 裸ID速查] 会话 ${found.conversationId} | 目标: ${goal} | ` +
          `步数: ${stepLabel} (记录 ${info.lineCount} 条) | 模型: ${model} | ` +
          `更新: ${updated} | 状态: ${st} | 压缩次数: ${info.compactions}${err}`;
        injectSteps.push({ systemMessage: { systemMessage: note } });
      } else if (found.status === 'ambiguous' && found.matches.length > 0) {
        const preview = found.matches.slice(0, 4).join(', ');
        const note = `[control-tower 裸ID速查] 前缀 ${cand} 匹配多个会话 (${preview})，请补全更长 ID 后再入账。`;
        injectSteps.push({ systemMessage: { systemMessage: note } });
      }
    }
  }

  // 2) One-shot plugin version upgrade notice & flexible anti-aging handover warning
  const selfTp = resolveSelfTranscript(payload, convId, hintPath);
  let selfInfo = null;
  if (selfTp) {
    const prevSelfCache = state.transcriptCache[selfTp] || null;
    const inspected = inspectTranscript(selfTp, { cacheEntry: prevSelfCache });
    selfInfo = inspected.info;
    if (inspected.nextCacheEntry && inspected.nextCacheEntry !== prevSelfCache) {
      state.transcriptCache[selfTp] = inspected.nextCacheEntry;
      touchedCacheKeys.add(selfTp);
    }
  }

  const currentVersion = readInstalledPluginVersion();
  const prevCtrlEntry = state.controllers[convId] || {};
  const ctrlPatch = {};
  let ctrlDirty = false;

  if (currentVersion && prevCtrlEntry.lastSyncedVersion !== currentVersion) {
    const hasPriorHistory =
      Boolean(prevCtrlEntry.lastSyncedVersion) ||
      Number(payload.invocationNum || 0) > 1 ||
      (selfInfo && (selfInfo.lineCount >= 2 || selfInfo.maxStepIndex >= 1));
    if (hasPriorHistory) {
      const syncMsg =
        `[control-tower 版本同步] 本机 control-tower 插件已更新至 v${currentVersion}。` +
        `请在本轮处理前重读最新版 control-tower 技能规范（SKILL.md、references/model-routing.md 与 references/templates.md），` +
        `同步最新模型路由、协同矩阵、缓存保护护栏、执行层精确读行纪律及账号无 Carbon 临时降档策略。`;
      injectSteps.push({ systemMessage: { systemMessage: syncMsg } });
      appendFlightEvent(dataDir, {
        level: 'info',
        source: 'hook',
        event: 'version_sync_notified',
        conv: convId,
        message: `Notified controller of v${currentVersion}`,
        detail: { prevVersion: prevCtrlEntry.lastSyncedVersion || '', currentVersion },
      });
    }
    ctrlPatch.lastSyncedVersion = currentVersion;
    ctrlPatch.updatedAt = Date.now();
    ctrlDirty = true;
  }

  if (selfInfo) {
    const comps = selfInfo.compactions || 0;
    const threshold = resolved.effective.controllerCompactionThreshold || 5;
    const lastWarned = prevCtrlEntry.lastWarnedCompactions || 0;
    if (!prevCtrlEntry.handoverIgnored && comps >= threshold && Number(lastWarned) < threshold) {
      const handoverLearnSuffix =
        autoLearnMode !== 'off'
          ? '换届前请一并自检本任期是否有值得按 /learn 沉淀的可复用经验提案（无则跳过）。'
          : '';
      const warn =
        `[control-tower 换届提醒] 当前现役总控会话已累计 ${comps} 次上下文自动压缩（>= ${threshold} 次阈值，非强制）。` +
        `请通过 ask_question 询问用户：选择立即换届（同步 ${regFound.absPath}、输出交接卡并可用 agentapi new-conversation 一键拉起新总控接班），` +
        `或选择「本会话忽略不再提醒」（也可在总控看板顶部一键忽略）。${handoverLearnSuffix}`;
      injectSteps.push({ systemMessage: { systemMessage: warn } });
      appendFlightEvent(dataDir, {
        level: 'warn',
        source: 'hook',
        event: 'handover_warned',
        conv: convId,
        message: `Controller compactions ${comps} reached threshold ${threshold}`,
        detail: { compactions: comps, threshold },
      });
      ctrlPatch.lastWarnedCompactions = comps;
      ctrlPatch.updatedAt = Date.now();
      ctrlDirty = true;
      try {
        upsertInboxItem(dataDir, regFound.workspace, {
          dedupKey: `handover:${convId.slice(0, 8)}`,
          priority: 'P1',
          kind: 'handover',
          source: 'hook',
          convId,
          title: '现役总控达到换届提醒阈值',
          summary: `总控已累计压缩 ${comps} 次（阈值 ${threshold} 次），可一键接班或忽略`,
        });
      } catch {
        // ignore inbox error
      }
    }
  }

  // 3) Smart Dual-Trigger Auto-/learn Checkpoints (zero-force proposal workflow)
  if (autoLearnMode !== 'off') {
    const isMilestoneReport =
      hasDeferredReceiptInjected ||
      lastInput.includes('[CT_REPORT:DONE]') ||
      lastInput.includes('[CT_AUTO_RECEIPT]');
    if (isMilestoneReport) {
      const nowMs = Date.now();
      const hasCandidate = hasNonEmptyLearnCandidate(lastInput);
      const lastCheckpointAt = Number(prevCtrlEntry.lastLearnCheckpointAt || 0);
      if (hasCandidate || nowMs - lastCheckpointAt >= LEARN_MILESTONE_THROTTLE_MS) {
        injectSteps.push({
          systemMessage: {
            systemMessage:
              `[control-tower 自学习检查点] 本阶段任务收口或回执已到达，请核查专职回报中的「可沉淀经验候选」与本轮排障根因；` +
              `若存在可复用约束或技巧，请按原生 /learn 规范产出精简 learning_proposal.md 提案供用户审批后再落盘（优先写当前工作区 .agents/，严禁擅改规则；无新经验请静默跳过）。`,
          },
        });
        learnCheckpointInjected = true;
        ctrlPatch.lastLearnCheckpointAt = nowMs;
        ctrlPatch.updatedAt = nowMs;
        ctrlDirty = true;
        appendFlightEvent(dataDir, {
          level: 'info',
          source: 'hook',
          event: 'learn_checkpoint_injected',
          conv: convId,
          message: hasCandidate
            ? 'Injected milestone auto-/learn checkpoint (explicit candidate present)'
            : 'Injected throttled milestone auto-/learn checkpoint',
          detail: { hasCandidate },
        });
      }
    } else if (
      autoLearnMode === 'smart_proposal' &&
      !isAutomatedInbound &&
      !learnCheckpointInjected &&
      detectUserCorrectionSignal(strippedInput || lastInput)
    ) {
      const nowMs = Date.now();
      const lastHintAt = Number(prevCtrlEntry.lastLearnHintAt || 0);
      if (nowMs - lastHintAt >= LEARN_CORRECTION_THROTTLE_MS) {
        injectSteps.push({
          systemMessage: {
            systemMessage:
              `[control-tower 纠偏自学习提醒] 检测到本轮包含明确纠偏或长期约束，请先完整解决用户当前问题，` +
              `并在末尾评估是否需要按原生 /learn 流程产出精简 learning_proposal.md 提案供审批持久化（优先落当前工作区，绝不擅改规则/全局配置）。`,
          },
        });
        ctrlPatch.lastLearnHintAt = nowMs;
        ctrlPatch.updatedAt = nowMs;
        ctrlDirty = true;
        appendFlightEvent(dataDir, {
          level: 'info',
          source: 'hook',
          event: 'learn_hint_injected',
          conv: convId,
          message: 'Injected throttled user-correction auto-/learn proposal reminder',
        });
      }
    }
  }

  const hasLegacyAttention = Array.isArray(state.pendingAttention) && state.pendingAttention.length > 0;
  if (ctrlDirty || deferredCompletedIds.length > 0 || touchedCacheKeys.size > 0 || hasLegacyAttention) {
    try {
      updatePluginState(dataDir, (latest) => {
        if (ctrlDirty) {
          latest.controllers[convId] = {
            ...(latest.controllers[convId] || {}),
            ...ctrlPatch,
          };
        }
        for (const k of deferredCompletedIds) {
          if (latest.workers?.[k]) {
            latest.workers[k].pendingSilentDone = false;
          }
        }
        for (const k of touchedCacheKeys) {
          if (state.transcriptCache[k]) {
            latest.transcriptCache[k] = state.transcriptCache[k];
          }
        }
        latest.pendingAttention = [];
      });
    } catch (err) {
      appendFlightEvent(dataDir, {
        level: 'error',
        source: 'hook',
        event: 'state_save_failed',
        ok: false,
        conv: convId,
        message: err?.message || 'Failed to save state in PreInvocation',
      });
    }
  }

  if (existsSync(dataDir)) {
    try {
      recordKnownWorkspace(dataDir, regFound.workspace);
    } catch {
      // ignore recent workspace tracking error
    }
  }

  if (injectSteps.length === 0) {
    process.stdout.write('{}\n');
    return;
  }
  process.stdout.write(`${JSON.stringify({ injectSteps })}\n`);
}

function findWorkerStateEntry(workersMap, idOrPrefix) {
  if (!workersMap || typeof workersMap !== 'object' || !idOrPrefix) return null;
  if (workersMap[idOrPrefix]) return { key: idOrPrefix, entry: workersMap[idOrPrefix] };
  for (const [k, v] of Object.entries(workersMap)) {
    if (sameControllerId(k, idOrPrefix)) {
      return { key: k, entry: v };
    }
  }
  return null;
}

function handleStop(payload, regFound, parsedReg, resolved, dataDir, hintPath, convId) {
  // Always release controller inFlight when controller stops (even on ask_question, cancel, or non-NO_TOOL_CALL)
  if (isActiveController(convId, parsedReg)) {
    if (payload.continuationActive !== true) {
      try {
        const curInbox = loadWorkspaceInbox(dataDir, regFound.workspace);
        if (curInbox.focus.inFlight || curInbox.focus.lastUserInputAt > 0) {
          recordControllerFocus(dataDir, regFound.workspace, {
            controllerId: convId,
            inFlight: false,
            lastTurnEndAt: Date.now(),
          });
        }
      } catch {
        // ignore focus update errors
      }
    }
    process.stdout.write('{}\n');
    return;
  }

  if (
    resolved.plugin.stopHookReportEnabled === false ||
    payload.continuationActive === true ||
    payload.terminationReason !== 'NO_TOOL_CALL' ||
    payload.fullyIdle === false
  ) {
    process.stdout.write('{}\n');
    return;
  }

  if (!hasValidController(parsedReg)) {
    process.stdout.write('{}\n');
    return;
  }

  const workerRow = findActiveWorkerSession(convId, parsedReg);
  if (!workerRow || String(workerRow.status || '').toUpperCase() === 'DONE') {
    process.stdout.write('{}\n');
    return;
  }

  const ctrlId = String(parsedReg.controller.currentControllerId).trim();
  const selfTp = resolveSelfTranscript(payload, convId, hintPath);
  if (!selfTp) {
    process.stdout.write('{}\n');
    return;
  }

  const initialState = loadPluginState(dataDir);
  const prevCache = initialState.transcriptCache[selfTp] || null;
  const { info, nextCacheEntry } = inspectTranscript(selfTp, { cacheEntry: prevCache });

  const currentStep = info.maxStepIndex || info.lineCount || 0;
  const prevWorkerMatch = findWorkerStateEntry(initialState.workers, convId);
  const prevWorker = prevWorkerMatch?.entry || {};
  if (currentStep === 0 || prevWorker.lastReportedStep >= currentStep) {
    process.stdout.write('{}\n');
    return;
  }

  if (hasOutboundAgentApiReport(selfTp, ctrlId)) {
    try {
      updatePluginState(dataDir, (st) => {
        if (nextCacheEntry && nextCacheEntry !== prevCache) {
          st.transcriptCache[selfTp] = nextCacheEntry;
        }
        const m = findWorkerStateEntry(st.workers, convId);
        const key = m?.key || convId;
        st.workers[key] = {
          ...(m?.entry || {}),
          lastReportedStep: currentStep,
          pendingSilentDone: false,
          updatedAt: Date.now(),
        };
      });
    } catch (err) {
      appendFlightEvent(dataDir, {
        level: 'error',
        source: 'hook',
        event: 'state_save_failed',
        ok: false,
        conv: convId,
        message: err?.message || 'Failed to save state in Stop (already_reported)',
      });
    }
    appendFlightEvent(dataDir, {
      level: 'info',
      source: 'hook',
      event: 'stop_wake_skipped',
      conv: convId,
      message: 'Worker already sent outbound report to active controller',
      detail: { reason: 'already_reported', currentStep },
    });
    process.stdout.write('{}\n');
    return;
  }

  const summary = workerRow.topic || info.goal || convId.slice(0, 8);
  const isLockedWorker =
    resolved.effective.exclusiveLeaseEnabled !== false &&
    /持|LOCKED/i.test(workerRow.lockStatus || '') &&
    !/无锁|纯离线|无独占/i.test(workerRow.lockStatus || '');

  const otherActive = (parsedReg.activeSessions || []).filter(
    (s) =>
      s.conversationId &&
      !sameControllerId(s.conversationId, convId) &&
      String(s.status || '').toUpperCase() === 'ACTIVE'
  );

  // Phase 1 locked state update: atomically mark this worker pendingSilentDone and inspect peers
  let allOthersDone = false;
  const peerCompletedItems = [];
  const completedStateKeys = [convId];

  try {
    updatePluginState(dataDir, (st) => {
      if (nextCacheEntry && nextCacheEntry !== prevCache) {
        st.transcriptCache[selfTp] = nextCacheEntry;
      }
      const selfMatch = findWorkerStateEntry(st.workers, convId);
      const selfKey = selfMatch?.key || convId;
      completedStateKeys[0] = selfKey;
      st.workers[selfKey] = {
        ...(selfMatch?.entry || {}),
        lastReportedStep: currentStep,
        pendingSilentDone: true,
        summary,
        updatedAt: Date.now(),
      };

      allOthersDone = otherActive.every((s) => {
        const pm = findWorkerStateEntry(st.workers, s.conversationId);
        return Boolean(pm?.entry?.pendingSilentDone);
      });

      for (const s of otherActive) {
        const pm = findWorkerStateEntry(st.workers, s.conversationId);
        if (pm?.entry?.pendingSilentDone) {
          completedStateKeys.push(pm.key);
          peerCompletedItems.push(
            `${s.conversationId.slice(0, 8)} (${s.topic || pm.entry.summary || '-'})`
          );
        }
      }
    });
  } catch (err) {
    appendFlightEvent(dataDir, {
      level: 'error',
      source: 'hook',
      event: 'state_save_failed',
      ok: false,
      conv: convId,
      message: err?.message || 'Failed to save state in Stop phase 1',
    });
  }

  const shouldWake = Boolean(
    resolved.effective.notifyOnSingleTaskDone || isLockedWorker || allOthersDone
  );

  // Record worker stage completion in workspace priority inbox (P1 for milestone/lock, P2 for single routine)
  try {
    upsertInboxItem(dataDir, regFound.workspace, {
      dedupKey: `stop:${convId.slice(0, 8)}:${currentStep}`,
      priority: isLockedWorker || allOthersDone ? 'P1' : 'P2',
      kind: allOthersDone ? 'batch_done' : 'worker_done',
      source: 'hook',
      convId,
      title: allOthersDone
        ? `阶段活跃任务已全部完成 (${summary})`
        : `专职会话完成阶段运行 (${summary})`,
      summary: `会话 ${convId.slice(0, 8)} 停稳于步数 ${currentStep}${isLockedWorker ? '（持独占锁，待核验交锁）' : ''}`,
    });
    recordKnownWorkspace(dataDir, regFound.workspace);
  } catch {
    // ignore inbox persistence errors
  }

  if (shouldWake) {
    const items = [`${convId.slice(0, 8)} (${summary}, 步数 ${currentStep})`, ...peerCompletedItems];
    const receipt =
      `[CT_AUTO_RECEIPT] 以下专职会话已完成当前阶段运行（Stop 自动补发回执）：` +
      `${items.join('；')}。工作区: ${regFound.workspace}。请核查尾步结果、更新台账并按需向用户输出阶段汇总。`;

    const inboxForGate = loadWorkspaceInbox(dataDir, regFound.workspace);
    const gate = evaluateFocusGate(inboxForGate.focus, {
      focusCooldownSec: resolved.plugin.focusCooldownSec,
    });
    if (gate.isForegroundBusy) {
      try {
        setDeferredReceipt(dataDir, regFound.workspace, {
          controllerId: ctrlId,
          message: receipt,
          completedIds: completedStateKeys,
          createdAt: Date.now(),
        });
      } catch {
        // ignore deferred persistence error
      }
      appendFlightEvent(dataDir, {
        level: 'info',
        source: 'hook',
        event: 'stop_wake_deferred_focus_gate',
        conv: convId,
        message: `Deferred Stop wakeup due to foreground Focus Gate (${gate.mode})`,
        detail: {
          mode: gate.mode,
          remainingCooldownSec: gate.remainingCooldownSec,
          isLockedWorker,
          allOthersDone,
        },
      });
    } else if (!canInvokeAgentApiInHook()) {
      // Zero-token dual-track: Hook subprocess lacks ANTIGRAVITY_LS_ADDRESS, queue cleanly for Sidecar/PreInvocation
      try {
        setDeferredReceipt(dataDir, regFound.workspace, {
          controllerId: ctrlId,
          message: receipt,
          completedIds: completedStateKeys,
          createdAt: Date.now(),
        });
      } catch {
        // ignore deferred persistence error
      }
      appendFlightEvent(dataDir, {
        level: 'info',
        source: 'hook',
        event: 'stop_receipt_queued_inbox',
        conv: convId,
        message: `Queued Stop receipt in inbox for Sidecar or PreInvocation delivery (${completedStateKeys.length} worker(s))`,
        detail: { completedCount: completedStateKeys.length, isLockedWorker, allOthersDone },
      });
    } else {
      try {
        sendAgentApiMessage(ctrlId, '[CT阶段回执]', receipt);
        clearDeferredReceipt(dataDir, regFound.workspace);
        // Phase 2 short lock: clear pendingSilentDone only for delivered workers
        updatePluginState(dataDir, (st) => {
          for (const key of completedStateKeys) {
            if (st.workers[key]) {
              st.workers[key].pendingSilentDone = false;
            }
          }
        });
        appendFlightEvent(dataDir, {
          level: 'info',
          source: 'hook',
          event: 'stop_receipt_sent',
          conv: convId,
          message: `Sent batched Stop receipt for ${completedStateKeys.length} worker(s)`,
          detail: { completedCount: completedStateKeys.length, isLockedWorker, allOthersDone },
        });
      } catch (err) {
        try {
          setDeferredReceipt(dataDir, regFound.workspace, {
            controllerId: ctrlId,
            message: receipt,
            completedIds: completedStateKeys,
            createdAt: Date.now(),
          });
        } catch {
          // ignore fallback persistence error
        }
        appendFlightEvent(dataDir, {
          level: 'error',
          source: 'hook',
          event: 'stop_agentapi_failed',
          ok: false,
          conv: convId,
          message: err?.message || 'agentapi send-message failed in Stop hook',
          detail: { completedCount: completedStateKeys.length },
        });
      }
    }
  } else {
    appendFlightEvent(dataDir, {
      level: 'info',
      source: 'hook',
      event: 'stop_wake_skipped',
      conv: convId,
      message: 'Deferred wake waiting for peer active workers',
      detail: { reason: 'silent_batch_pending', remainingPeers: otherActive.length },
    });
  }

  process.stdout.write('{}\n');
}

function findMatchingRegistriesForTargets(wsPaths, targets, payloadCwd, argsCwd, dataDir) {
  if (!Array.isArray(targets) || targets.length === 0) return [];

  const rawCandidates = [];
  if (Array.isArray(wsPaths)) {
    for (const w of wsPaths) {
      if (typeof w === 'string' && w.trim()) rawCandidates.push(w);
    }
  }
  const fallbackWs = rawCandidates[0] || '';
  const baseForGuess = resolveEffectiveBaseDir(payloadCwd, argsCwd, fallbackWs);
  if (typeof argsCwd === 'string' && argsCwd.trim() && baseForGuess) {
    rawCandidates.push(baseForGuess);
  }

  for (const t of targets) {
    const targetReal = resolveCanonicalPath(t.rawPath, baseForGuess);
    if (!targetReal || basename(targetReal) !== 'SESSION-REGISTRY.md') continue;
    const parent = dirname(targetReal);
    rawCandidates.push(parent);
    const parentName = basename(parent);
    if (parentName === '.agents' || parentName === 'research') {
      const grandParent = dirname(parent);
      if (grandParent && grandParent !== parent) {
        rawCandidates.push(grandParent);
      }
    }
  }

  const matches = [];
  const seenWorkspaces = new Set();
  const seenRegPaths = new Set();
  for (const rawWs of rawCandidates) {
    const wsReal = normalizeWorkspaceInput(rawWs, { throwOnInvalid: false });
    if (!wsReal || seenWorkspaces.has(wsReal)) continue;
    seenWorkspaces.add(wsReal);
    try {
      const found = findExistingRegistry(wsReal, { dataDir });
      if (!found) continue;
      const regReal = resolveCanonicalPath(found.absPath);
      if (!regReal || seenRegPaths.has(regReal)) continue;
      seenRegPaths.add(regReal);
      const baseDir = resolveEffectiveBaseDir(payloadCwd, argsCwd, wsReal);
      const hitTargets = targets.filter((t) => resolveCanonicalPath(t.rawPath, baseDir) === regReal);
      if (hitTargets.length > 0) {
        matches.push({
          regFound: { workspace: wsReal, ...found },
          regReal,
          hitTargets,
        });
      }
    } catch {
      continue;
    }
  }
  return matches;
}

function run() {
  const startedAt = Date.now();
  const raw = readStdinSync();
  let payload = {};
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') payload = parsed;
    } catch {
      process.stdout.write('{}\n');
      return;
    }
  }

  const eventName = process.argv[2] || String(payload.hookEventName || '').trim();
  const convId = String(payload.conversationId || '').trim();
  const wsPaths = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [];
  const hintPath = String(payload.transcriptPath || payload.artifactDirectoryPath || '').trim();
  const dataDir = resolvePluginDataDir({ hintPath });

  if (eventName === 'PreToolUse') {
    const unwrapped = unwrapPreToolCall(payload?.toolCall);
    if (unwrapped.kind === 'ignore') {
      process.stdout.write('{"decision":"allow"}\n');
      return;
    }
    const targets = extractPreToolWriteTargets(unwrapped);
    if (!convId || targets.length === 0) {
      process.stdout.write('{"decision":"allow"}\n');
      return;
    }
    const argsCwd =
      typeof unwrapped.toolArgs?.cwd === 'string' ? unwrapped.toolArgs.cwd : '';
    const hits = findMatchingRegistriesForTargets(
      wsPaths,
      targets,
      String(payload.cwd || ''),
      argsCwd,
      dataDir
    );
    if (hits.length === 0) {
      process.stdout.write('{"decision":"allow"}\n');
      return;
    }

    let finalResult = { decision: 'allow' };
    for (const hit of hits) {
      let parsedReg;
      try {
        parsedReg = parseRegistry(readFileSync(hit.regFound.absPath, 'utf8'));
      } catch (err) {
        appendFlightEvent(dataDir, {
          level: 'error',
          source: 'hook',
          event: 'registry_parse_failed',
          ok: false,
          conv: convId,
          message: err?.message || 'Failed to parse SESSION-REGISTRY.md',
          detail: { eventName, relPath: hit.regFound.relPath },
        });
        continue;
      }
      const resolved = resolveEffectiveSettings({
        dataDir,
        wsReal: hit.regFound.workspace,
        pluginRoot: PLUGIN_ROOT,
      });
      const res = evaluatePreToolUse({
        payload,
        regFound: hit.regFound,
        parsedReg,
        resolved,
        dataDir,
        hintPath,
        convId,
        unwrapped,
        hitTargets: hit.hitTargets,
      });
      if (res.decision !== 'allow') {
        finalResult = res;
        break;
      }
    }
    process.stdout.write(`${JSON.stringify(finalResult)}\n`);

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= SLOW_OP_THRESHOLD_MS && existsSync(dataDir)) {
      appendFlightEvent(dataDir, {
        level: 'warn',
        source: 'hook',
        event: 'slow_hook',
        conv: convId,
        durationMs: elapsedMs,
        message: `Hook ${eventName || 'unknown'} took ${elapsedMs}ms`,
        detail: { eventName },
      });
    }
    return;
  }

  const regFound = findRegistryInWorkspaces(wsPaths, { dataDir });

  if (!convId || !regFound) {
    process.stdout.write('{}\n');
    return;
  }

  let parsedReg;
  try {
    parsedReg = parseRegistry(readFileSync(regFound.absPath, 'utf8'));
  } catch (err) {
    appendFlightEvent(dataDir, {
      level: 'error',
      source: 'hook',
      event: 'registry_parse_failed',
      ok: false,
      conv: convId,
      message: err?.message || 'Failed to parse SESSION-REGISTRY.md',
      detail: { eventName, relPath: regFound.relPath },
    });
    process.stdout.write('{}\n');
    return;
  }

  const resolved = resolveEffectiveSettings({
    dataDir,
    wsReal: regFound.workspace,
    pluginRoot: PLUGIN_ROOT,
  });

  if (eventName === 'SessionStart') {
    handleSessionStart(regFound, parsedReg, resolved, dataDir, convId);
  } else if (eventName === 'PreInvocation') {
    handlePreInvocation(payload, regFound, parsedReg, resolved, dataDir, hintPath, convId);
  } else if (eventName === 'Stop') {
    handleStop(payload, regFound, parsedReg, resolved, dataDir, hintPath, convId);
  } else {
    process.stdout.write('{}\n');
  }

  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs >= SLOW_OP_THRESHOLD_MS && existsSync(dataDir)) {
    appendFlightEvent(dataDir, {
      level: 'warn',
      source: 'hook',
      event: 'slow_hook',
      conv: convId,
      durationMs: elapsedMs,
      message: `Hook ${eventName || 'unknown'} took ${elapsedMs}ms`,
      detail: { eventName },
    });
  }
}

try {
  run();
} catch (err) {
  try {
    const dataDir = resolvePluginDataDir();
    if (existsSync(dataDir)) {
      appendFlightEvent(dataDir, {
        level: 'error',
        source: 'hook',
        event: 'hook_uncaught_error',
        ok: false,
        message: err?.message || 'Unhandled exception in ct-hook',
      });
    }
  } catch {
    // ignore logger failure
  }
  const eventName = process.argv[2] || '';
  if (eventName === 'PreToolUse') {
    process.stdout.write('{"decision":"allow"}\n');
  } else {
    process.stdout.write('{}\n');
  }
}
