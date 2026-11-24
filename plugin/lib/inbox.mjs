import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  atomicWriteText,
  getWorkspaceSettingsDir,
  readJsonSafe,
  withFileLockSync,
} from './paths.mjs';

export const INBOX_SCHEMA_VERSION = 2;
export const INBOX_MAX_ITEMS = 50;
export const DEFAULT_FOCUS_COOLDOWN_SEC = 180;
export const DEFAULT_STUCK_THRESHOLD_MIN = 15;

const VALID_PRIORITIES = new Set(['P0', 'P1', 'P2']);

export function getWorkspaceInboxPath(dataDir, wsReal) {
  return join(getWorkspaceSettingsDir(dataDir, wsReal), 'inbox.json');
}

function defaultInbox(wsReal = '') {
  return {
    version: INBOX_SCHEMA_VERSION,
    workspace: wsReal ? String(wsReal) : '',
    focus: {
      controllerId: '',
      inFlight: false,
      lastUserInputAt: 0,
      lastTurnEndAt: 0,
      updatedAt: 0,
    },
    lastSweepAt: 0,
    deferredReceipt: null,
    items: [],
  };
}

function withInboxLock(dataDir, wsReal, fn) {
  if (!dataDir || !wsReal) return fn();
  const lockPath = join(getWorkspaceSettingsDir(dataDir, wsReal), '.inbox.lock');
  return withFileLockSync(lockPath, fn);
}

function normalizePriority(p) {
  const up = String(p || 'P2').trim().toUpperCase();
  return VALID_PRIORITIES.has(up) ? up : 'P2';
}

function isLegacyV1FalsePositive(x) {
  if (!x || typeof x !== 'object') return false;
  const src = String(x.source || 'sentinel');
  const kind = String(x.kind || '');
  const title = String(x.title || '');
  if (src === 'sentinel' && kind === 'worker_error') return true;
  if (src === 'sentinel' && title.includes('[swarm] coordinator')) return true;
  return false;
}

function normalizeInbox(raw, wsHint = '') {
  const base = defaultInbox(wsHint);
  if (!raw || typeof raw !== 'object') return base;
  const rawVersion = Number(raw.version || 1);
  const f = raw.focus && typeof raw.focus === 'object' ? raw.focus : {};
  const items = Array.isArray(raw.items)
    ? raw.items
        .filter((x) => x && typeof x === 'object' && x.id)
        .filter((x) => !(rawVersion < INBOX_SCHEMA_VERSION && isLegacyV1FalsePositive(x)))
        .map((x) => ({
          id: String(x.id),
          dedupKey: String(x.dedupKey || x.id),
          priority: normalizePriority(x.priority),
          kind: String(x.kind || 'event'),
          source: String(x.source || 'sentinel'),
          convId: String(x.convId || ''),
          title: String(x.title || '').slice(0, 120),
          summary: String(x.summary || '').slice(0, 280),
          acked: Boolean(x.acked),
          createdAt: Number(x.createdAt || 0) || Date.now(),
          updatedAt: Number(x.updatedAt || 0) || Date.now(),
        }))
        .slice(-INBOX_MAX_ITEMS)
    : [];

  const dr =
    raw.deferredReceipt &&
    typeof raw.deferredReceipt === 'object' &&
    raw.deferredReceipt.controllerId &&
    raw.deferredReceipt.message
      ? {
          controllerId: String(raw.deferredReceipt.controllerId),
          message: String(raw.deferredReceipt.message).slice(0, 1200),
          completedIds: Array.isArray(raw.deferredReceipt.completedIds)
            ? raw.deferredReceipt.completedIds.map(String).slice(0, 20)
            : [],
          createdAt: Number(raw.deferredReceipt.createdAt || 0) || Date.now(),
        }
      : null;

  return {
    version: INBOX_SCHEMA_VERSION,
    workspace: String(raw.workspace || wsHint || ''),
    focus: {
      controllerId: String(f.controllerId || ''),
      inFlight: Boolean(f.inFlight),
      lastUserInputAt: Number(f.lastUserInputAt || 0) || 0,
      lastTurnEndAt: Number(f.lastTurnEndAt || 0) || 0,
      updatedAt: Number(f.updatedAt || 0) || 0,
    },
    lastSweepAt: Number(raw.lastSweepAt || 0) || 0,
    deferredReceipt: dr,
    items,
  };
}

export function loadWorkspaceInbox(dataDir, wsReal) {
  if (!dataDir || !wsReal) return defaultInbox(wsReal);
  const raw = readJsonSafe(getWorkspaceInboxPath(dataDir, wsReal), null);
  return normalizeInbox(raw, wsReal);
}

export function saveWorkspaceInbox(dataDir, wsReal, inbox) {
  if (!dataDir || !wsReal) return normalizeInbox(inbox, wsReal);
  const norm = normalizeInbox(inbox, wsReal);
  norm.workspace = String(wsReal || norm.workspace || '');
  atomicWriteText(getWorkspaceInboxPath(dataDir, wsReal), `${JSON.stringify(norm, null, 2)}\n`);
  return norm;
}

export function recordControllerFocus(dataDir, wsReal, patch = {}) {
  return withInboxLock(dataDir, wsReal, () => {
    const inbox = loadWorkspaceInbox(dataDir, wsReal);
    const now = Number(patch.nowMs) || Date.now();
    inbox.focus = {
      ...inbox.focus,
      ...(patch.controllerId !== undefined ? { controllerId: String(patch.controllerId || '') } : {}),
      ...(patch.inFlight !== undefined ? { inFlight: Boolean(patch.inFlight) } : {}),
      ...(patch.lastUserInputAt !== undefined ? { lastUserInputAt: Number(patch.lastUserInputAt) || 0 } : {}),
      ...(patch.lastTurnEndAt !== undefined ? { lastTurnEndAt: Number(patch.lastTurnEndAt) || 0 } : {}),
      updatedAt: now,
    };
    if (patch.clearDeferredReceipt) {
      inbox.deferredReceipt = null;
    }
    return saveWorkspaceInbox(dataDir, wsReal, inbox);
  });
}

export function setDeferredReceipt(dataDir, wsReal, receipt) {
  if (!dataDir || !wsReal || !receipt) return null;
  return withInboxLock(dataDir, wsReal, () => {
    const inbox = loadWorkspaceInbox(dataDir, wsReal);
    inbox.deferredReceipt = {
      controllerId: String(receipt.controllerId || ''),
      message: String(receipt.message || '').slice(0, 1200),
      completedIds: Array.isArray(receipt.completedIds) ? receipt.completedIds.map(String) : [],
      createdAt: Number(receipt.createdAt) || Date.now(),
    };
    return saveWorkspaceInbox(dataDir, wsReal, inbox);
  });
}

export function clearDeferredReceipt(dataDir, wsReal) {
  if (!dataDir || !wsReal) return null;
  const p = getWorkspaceInboxPath(dataDir, wsReal);
  if (!existsSync(p)) return null;
  return withInboxLock(dataDir, wsReal, () => {
    const inbox = loadWorkspaceInbox(dataDir, wsReal);
    if (!inbox.deferredReceipt) return inbox;
    inbox.deferredReceipt = null;
    return saveWorkspaceInbox(dataDir, wsReal, inbox);
  });
}

export function evaluateFocusGate(focus, { nowMs = Date.now(), focusCooldownSec = DEFAULT_FOCUS_COOLDOWN_SEC } = {}) {
  const f = focus && typeof focus === 'object' ? focus : {};
  const cooldownMs = Math.max(30, Number(focusCooldownSec) || DEFAULT_FOCUS_COOLDOWN_SEC) * 1000;
  const lastActivity = Math.max(Number(f.lastUserInputAt || 0), Number(f.lastTurnEndAt || 0));
  const elapsedMs = lastActivity > 0 ? Math.max(0, nowMs - lastActivity) : Infinity;

  // Guard against stale inFlight flag if controller crashed or never triggered Stop
  const staleFlightMs = Math.max(cooldownMs, 5 * 60 * 1000);
  const isInFlight = Boolean(f.inFlight) && elapsedMs < staleFlightMs;
  let mode = 'idle';
  if (isInFlight) {
    mode = 'in_flight';
  } else if (lastActivity > 0 && elapsedMs < cooldownMs) {
    mode = 'focused';
  }

  return {
    mode,
    isForegroundBusy: mode !== 'idle',
    remainingCooldownSec: mode === 'focused' ? Math.max(0, Math.ceil((cooldownMs - elapsedMs) / 1000)) : 0,
    shouldInterruptFor(priority) {
      const p = normalizePriority(priority);
      if (mode === 'in_flight') return false;
      if (mode === 'focused') return false;
      return p === 'P0' || p === 'P1';
    },
  };
}

export function upsertInboxItem(dataDir, wsReal, entry) {
  return withInboxLock(dataDir, wsReal, () => {
    const inbox = loadWorkspaceInbox(dataDir, wsReal);
    const now = Number(entry?.nowMs) || Date.now();
    const dedupKey = String(entry?.dedupKey || entry?.id || `${entry?.kind || 'ev'}-${now}`);
    const idx = inbox.items.findIndex((x) => x.dedupKey === dedupKey);
    const priority = normalizePriority(entry?.priority);

    if (idx >= 0) {
      const prev = inbox.items[idx];
      const changed =
        prev.summary !== String(entry?.summary || prev.summary).slice(0, 280) ||
        prev.priority !== priority;
      inbox.items[idx] = {
        ...prev,
        priority,
        kind: String(entry?.kind || prev.kind),
        source: String(entry?.source || prev.source),
        convId: String(entry?.convId ?? prev.convId),
        title: String(entry?.title || prev.title).slice(0, 120),
        summary: String(entry?.summary || prev.summary).slice(0, 280),
        acked: entry?.reopenOnUpdate === false ? prev.acked : changed ? false : prev.acked,
        updatedAt: now,
      };
    } else {
      inbox.items.push({
        id: String(entry?.id || `inb-${now.toString(36)}-${Math.random().toString(16).slice(2, 6)}`),
        dedupKey,
        priority,
        kind: String(entry?.kind || 'event'),
        source: String(entry?.source || 'sentinel'),
        convId: String(entry?.convId || ''),
        title: String(entry?.title || '事件通知').slice(0, 120),
        summary: String(entry?.summary || '').slice(0, 280),
        acked: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (inbox.items.length > INBOX_MAX_ITEMS) {
      const unacked = inbox.items.filter((x) => !x.acked);
      const acked = inbox.items.filter((x) => x.acked);
      const keepAcked = Math.max(0, INBOX_MAX_ITEMS - unacked.length);
      const tailAcked = keepAcked > 0 ? acked.slice(-keepAcked) : [];
      inbox.items = [...tailAcked, ...unacked.slice(-INBOX_MAX_ITEMS)];
    }
    return saveWorkspaceInbox(dataDir, wsReal, inbox);
  });
}

export function ackInboxItems(dataDir, wsReal, { id = '', ids = [], ackAll = false, priority = '' } = {}) {
  return withInboxLock(dataDir, wsReal, () => {
    const inbox = loadWorkspaceInbox(dataDir, wsReal);
    const now = Date.now();
    const wantP = priority ? normalizePriority(priority) : '';
    const idSet = new Set(Array.isArray(ids) ? ids.filter(Boolean).map(String) : []);
    if (id) idSet.add(String(id));
    for (const item of inbox.items) {
      if (ackAll || idSet.has(item.id) || (wantP && item.priority === wantP)) {
        item.acked = true;
        item.updatedAt = now;
      }
    }
    return saveWorkspaceInbox(dataDir, wsReal, inbox);
  });
}

function sameConvIdPrefix(a, b) {
  if (!a || !b) return false;
  const x = String(a).trim().toLowerCase();
  const y = String(b).trim().toLowerCase();
  return x === y || (x.length >= 8 && y.length >= 8 && (x.startsWith(y) || y.startsWith(x)));
}

/**
 * Automatically prune retired-controller handover/decision relics and expired routine items.
 */
export function pruneInboxItems(
  items,
  {
    activeControllerId = '',
    handoverIgnored = false,
    nowMs = Date.now(),
    ackedTtlMs = 24 * 3600 * 1000,
    p2TtlMs = 48 * 3600 * 1000,
    decisionTtlMs = 24 * 3600 * 1000,
  } = {}
) {
  if (!Array.isArray(items)) return [];
  const ctrl = String(activeControllerId || '').trim();
  return items.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    const age = Math.max(0, nowMs - (Number(item.updatedAt || item.createdAt || 0) || nowMs));
    if (item.acked && age > ackedTtlMs) return false;
    if (item.priority === 'P2' && age > p2TtlMs) return false;
    if (item.kind === 'decision' && age > decisionTtlMs) return false;
    if (
      handoverIgnored &&
      item.kind === 'handover' &&
      (!ctrl || !item.convId || sameConvIdPrefix(item.convId, ctrl))
    ) {
      return false;
    }
    if (
      ctrl &&
      (item.kind === 'handover' || item.kind === 'decision') &&
      item.convId &&
      !sameConvIdPrefix(item.convId, ctrl)
    ) {
      return false;
    }
    return true;
  });
}

export function cleanupWorkspaceInbox(dataDir, wsReal, opts = {}) {
  if (!dataDir || !wsReal) return defaultInbox(wsReal);
  const inboxPath = getWorkspaceInboxPath(dataDir, wsReal);
  if (!existsSync(inboxPath)) return defaultInbox(wsReal);
  return withInboxLock(dataDir, wsReal, () => {
    const rawOnDisk = readJsonSafe(inboxPath, null);
    const needsSchemaUpgrade =
      !rawOnDisk ||
      Number(rawOnDisk.version || 1) < INBOX_SCHEMA_VERSION ||
      rawOnDisk.workspace !== wsReal;
    const inbox = normalizeInbox(rawOnDisk, wsReal);
    const nextItems = pruneInboxItems(inbox.items, opts);
    if (needsSchemaUpgrade || nextItems.length !== inbox.items.length) {
      inbox.items = nextItems;
      return saveWorkspaceInbox(dataDir, wsReal, inbox);
    }
    return inbox;
  });
}

export function buildUnifiedAttentionBanner(
  inboxSummary,
  {
    activeControllerId = '',
    controllerCompactions = 0,
    compactionThreshold = 5,
    handoverIgnored = false,
  } = {}
) {
  const items = [];
  const seen = new Set();
  const ctrl = String(activeControllerId || '').trim();
  const sourceItems = Array.isArray(inboxSummary?.items) ? inboxSummary.items : [];

  for (const it of sourceItems) {
    if (!it || it.acked) continue;
    if (it.kind === 'handover' && handoverIgnored) continue;
    if (
      ctrl &&
      (it.kind === 'handover' || it.kind === 'decision') &&
      it.convId &&
      !sameConvIdPrefix(it.convId, ctrl)
    ) {
      continue;
    }
    if (it.priority === 'P0' || it.kind === 'handover') {
      items.push({
        id: it.id,
        kind: it.kind,
        priority: it.priority,
        controllerId: it.kind === 'handover' || it.kind === 'decision' ? it.convId || ctrl : ctrl,
        convId: it.convId || '',
        title: it.title || '',
        summary: it.summary || it.title || it.kind,
        updatedAt: it.updatedAt || Date.now(),
        source: 'inbox',
      });
      seen.add(it.kind === 'handover' ? `handover-${(it.convId || ctrl).slice(0, 8)}` : it.id);
    }
  }

  const comps = Number(controllerCompactions || 0);
  const thresh = Math.max(1, Number(compactionThreshold || 5));
  if (ctrl && !handoverIgnored && comps >= thresh) {
    const liveKey = `handover-${ctrl.slice(0, 8)}`;
    if (!seen.has(liveKey)) {
      items.unshift({
        id: liveKey,
        kind: 'handover',
        priority: 'P1',
        controllerId: ctrl,
        convId: ctrl,
        compactions: comps,
        threshold: thresh,
        title: '现役总控达到换届提醒阈值',
        summary: `总控已累计压缩 ${comps} 次（阈值 ${thresh} 次），可选择一键接班或本会话忽略`,
        updatedAt: Date.now(),
        source: 'live',
      });
    }
  }

  return { items, handoverIgnored };
}

export function summarizeInbox(
  inbox,
  {
    nowMs = Date.now(),
    focusCooldownSec = DEFAULT_FOCUS_COOLDOWN_SEC,
    activeControllerId = '',
    handoverIgnored = false,
  } = {}
) {
  const norm = normalizeInbox(inbox);
  const pruned = pruneInboxItems(norm.items, { activeControllerId, handoverIgnored, nowMs });
  const unread = pruned.filter((x) => !x.acked);
  const unreadCounts = { P0: 0, P1: 0, P2: 0, total: unread.length };
  for (const item of unread) {
    unreadCounts[item.priority] = (unreadCounts[item.priority] || 0) + 1;
  }
  const priorityRank = { P0: 0, P1: 1, P2: 2 };
  const sortedItems = [...pruned].sort((a, b) => {
    if (a.acked !== b.acked) return a.acked ? 1 : -1;
    if (priorityRank[a.priority] !== priorityRank[b.priority]) {
      return priorityRank[a.priority] - priorityRank[b.priority];
    }
    return b.updatedAt - a.updatedAt;
  });

  const gate = evaluateFocusGate(norm.focus, { nowMs, focusCooldownSec });
  return {
    focus: {
      ...norm.focus,
      mode: gate.mode,
      isForegroundBusy: gate.isForegroundBusy,
      remainingCooldownSec: gate.remainingCooldownSec,
    },
    lastSweepAt: norm.lastSweepAt,
    unreadCounts,
    items: sortedItems,
  };
}

export function buildInboxDigestLine(inbox) {
  const norm = normalizeInbox(inbox);
  const unread = norm.items.filter((x) => !x.acked);
  if (unread.length === 0) return '';
  const counts = { P0: 0, P1: 0, P2: 0 };
  for (const it of unread) counts[it.priority] = (counts[it.priority] || 0) + 1;
  const topP0 = unread.find((x) => x.priority === 'P0');
  const topP1 = unread.find((x) => x.priority === 'P1');
  const headline = topP0
    ? `最高优先 P0: ${topP0.title} (${topP0.summary.slice(0, 70)})`
    : topP1
      ? `阶段待处理 P1: ${topP1.title}`
      : `常规完成 P2: ${unread[0].title}`;

  if (counts.P0 > 0) {
    return (
      `[control-tower 收件箱 P0 提醒] 待处理 ${unread.length} 项 (P0:${counts.P0} P1:${counts.P1} P2:${counts.P2}) | ` +
      `${headline}。请先处理用户当前诉求，并在本轮同步提示该 P0 阻塞项供拍板。`
    );
  }
  return (
    `[control-tower 后台信箱静默摘要] 待处理 ${unread.length} 项 (P0:0 P1:${counts.P1} P2:${counts.P2}) | ` +
    `${headline}。当前处于前台对话焦点保护期，请 100% 优先回答用户当前问题，仅在回复末尾用 1 行简短附注提及（待用户要求时再展开处理）。`
  );
}

/**
 * Zero-Token Background Sentinel Sweep:
 * Evaluates active top-level sessions, Swarm members, and hidden subagents purely from
 * local transcript telemetry (0 LLM tokens) and upserts deduplicated P0/P1/P2 events.
 */
export function evaluateSentinelSweep({
  dataDir,
  wsReal,
  activeControllerId = '',
  activeSessions = [],
  nativeSwarm = null,
  subagents = [],
  workerCompactionThreshold = 2,
  stuckThresholdMin = DEFAULT_STUCK_THRESHOLD_MIN,
  nowMs = Date.now(),
} = {}) {
  const detected = [];
  const stuckMs = Math.max(5, Number(stuckThresholdMin) || DEFAULT_STUCK_THRESHOLD_MIN) * 60 * 1000;
  const compThresh = Math.max(1, Number(workerCompactionThreshold) || 2);
  const ctrlId = String(activeControllerId || '').trim();

  const erroredConvIds = [];
  const stuckConvIds = [];
  const topLevelActiveConvIds = [];

  const inspectTarget = ({ surface, id, label, status, telemetry }) => {
    if (!telemetry || !telemetry.exists) return;
    if (ctrlId && id && sameConvIdPrefix(id, ctrlId)) return;
    const shortId = id ? id.slice(0, 8) : label;
    const upperSt = String(status || '').toUpperCase();
    const lastUpdMs = telemetry.lastUpdatedAt ? Date.parse(telemetry.lastUpdatedAt) : 0;
    const idleMs = lastUpdMs > 0 ? Math.max(0, nowMs - lastUpdMs) : 0;
    const isExplicitErrorStatus = String(telemetry.lastStatus || '').toUpperCase() === 'ERROR';
    const isTerminalToolError =
      Boolean(telemetry.lastError) &&
      (String(telemetry.lastStepType || '').toUpperCase() === 'PLANNER_RESPONSE' ||
        lastUpdMs === 0 ||
        idleMs >= 45 * 1000);

    if (isExplicitErrorStatus || isTerminalToolError) {
      if (id) erroredConvIds.push(id);
      const errStep = telemetry.lastErrorStep || telemetry.maxStepIndex || telemetry.lineCount || 0;
      detected.push({
        dedupKey: `sentinel:err:${shortId}:${errStep}`,
        priority: 'P0',
        kind: 'worker_error',
        source: 'sentinel',
        convId: id || '',
        title: `[${surface}] ${label} 检测到异常报错`,
        summary: telemetry.lastError || `尾步状态为 ERROR (步数 ${telemetry.maxStepIndex || telemetry.lineCount})`,
      });
    }

    if (
      (upperSt === 'ACTIVE' || upperSt === 'WORKING' || upperSt === 'RUNNING') &&
      String(telemetry.lastStatus || '').toUpperCase() !== 'DONE' &&
      lastUpdMs > 0 &&
      idleMs >= stuckMs
    ) {
      if (id) stuckConvIds.push(id);
      const mins = Math.round(idleMs / 60000);
      detected.push({
        dedupKey: `sentinel:stuck:${shortId}:${telemetry.maxStepIndex || telemetry.lineCount}`,
        priority: 'P1',
        kind: 'worker_stuck',
        source: 'sentinel',
        convId: id || '',
        title: `[${surface}] ${label} 疑似卡死 (${mins}m 无推进)`,
        summary: `已连续 ${mins} 分钟停留在步数 ${telemetry.maxStepIndex || telemetry.lineCount}，建议抽查尾步或止损`,
      });
    }

    if ((telemetry.compactions || 0) >= compThresh) {
      detected.push({
        dedupKey: `sentinel:comp:${shortId}:${telemetry.compactions}`,
        priority: 'P2',
        kind: 'worker_compaction',
        source: 'sentinel',
        convId: id || '',
        title: `[${surface}] ${label} 压缩已达 ${telemetry.compactions} 次`,
        summary: `达到专职会话新建建议阈值 (${compThresh} 次)，下一子任务建议切干净新会话`,
      });
    }

    if (
      surface === 'topLevel' &&
      upperSt === 'ACTIVE' &&
      String(telemetry.lastStatus || '').toUpperCase() === 'DONE' &&
      lastUpdMs > 0 &&
      idleMs >= 60 * 1000
    ) {
      detected.push({
        dedupKey: `sentinel:done:${shortId}:${telemetry.maxStepIndex || telemetry.lineCount}`,
        priority: 'P2',
        kind: 'worker_done_unarchived',
        source: 'sentinel',
        convId: id || '',
        title: `[顶层会话] ${label} 已运行至 DONE 待收口`,
        summary: `尾步已停稳于步数 ${telemetry.maxStepIndex || telemetry.lineCount}，可在看板一键归档里程碑`,
      });
    }
  };

  for (const s of activeSessions || []) {
    if (s.conversationId && String(s.status || 'ACTIVE').toUpperCase() === 'ACTIVE') {
      topLevelActiveConvIds.push(s.conversationId);
    }
    inspectTarget({
      surface: 'topLevel',
      id: s.conversationId || '',
      label: s.topic || (s.conversationId || '').slice(0, 8) || 'worker',
      status: s.status || 'ACTIVE',
      telemetry: s.telemetry,
    });
  }

  if (nativeSwarm?.active && Array.isArray(nativeSwarm.members)) {
    for (const m of nativeSwarm.members) {
      if (m.state === 'killed') continue;
      if (
        String(m.role || '').toLowerCase() === 'coordinator' ||
        String(m.name || '').toLowerCase() === 'coordinator' ||
        (ctrlId && m.conversationId && sameConvIdPrefix(m.conversationId, ctrlId))
      ) {
        continue;
      }
      inspectTarget({
        surface: 'swarm',
        id: m.conversationId || '',
        label: m.name || 'swarm-worker',
        status: m.state || 'waiting',
        telemetry: {
          exists: Boolean(m.steps || m.lastError || m.lastUpdatedAt),
          maxStepIndex: m.steps || 0,
          lineCount: m.steps || 0,
          compactions: m.compactions || 0,
          lastStatus: m.state === 'working' ? 'RUNNING' : m.lastError ? 'ERROR' : 'DONE',
          lastStepType: m.lastStepType || 'PLANNER_RESPONSE',
          lastError: m.lastError || '',
          lastErrorStep: m.lastErrorStep || m.steps || 0,
          lastUpdatedAt: m.lastUpdatedAt || '',
        },
      });
    }
  }

  for (const sub of subagents || []) {
    inspectTarget({
      surface: 'subagent',
      id: sub.conversationId || '',
      label: sub.role || sub.typeName || 'subagent',
      status: sub.status || 'ACTIVE',
      telemetry: sub.telemetry || null,
    });
  }

  let inbox = loadWorkspaceInbox(dataDir, wsReal);
  const hadChanges = detected.length > 0;
  for (const item of detected) {
    inbox = upsertInboxItem(dataDir, wsReal, { ...item, nowMs, reopenOnUpdate: false });
  }
  const inboxPath = dataDir && wsReal ? getWorkspaceInboxPath(dataDir, wsReal) : '';
  if (dataDir && wsReal && (hadChanges || inbox.items.length > 0 || existsSync(inboxPath))) {
    inbox = withInboxLock(dataDir, wsReal, () => {
      const latest = loadWorkspaceInbox(dataDir, wsReal);
      for (const it of latest.items) {
        if (!it || it.acked || it.source !== 'sentinel') continue;
        if (String(it.title || '').startsWith('[swarm] coordinator ')) {
          it.acked = true;
          it.updatedAt = nowMs;
          continue;
        }
        if (ctrlId && it.convId && sameConvIdPrefix(it.convId, ctrlId)) {
          it.acked = true;
          it.updatedAt = nowMs;
          continue;
        }
        if (it.kind === 'worker_error') {
          const stillErrored =
            it.convId && erroredConvIds.some((cid) => sameConvIdPrefix(cid, it.convId));
          if (!stillErrored) {
            it.acked = true;
            it.updatedAt = nowMs;
          }
        } else if (it.kind === 'worker_stuck') {
          const stillStuck =
            it.convId && stuckConvIds.some((cid) => sameConvIdPrefix(cid, it.convId));
          if (!stillStuck) {
            it.acked = true;
            it.updatedAt = nowMs;
          }
        } else if (it.kind === 'worker_done_unarchived') {
          const stillActiveTop =
            it.convId && topLevelActiveConvIds.some((cid) => sameConvIdPrefix(cid, it.convId));
          if (!stillActiveTop) {
            it.acked = true;
            it.updatedAt = nowMs;
          }
        }
      }
      latest.lastSweepAt = nowMs;
      return saveWorkspaceInbox(dataDir, wsReal, latest);
    });
  }
  return { detectedCount: detected.length, detected, inbox };
}
