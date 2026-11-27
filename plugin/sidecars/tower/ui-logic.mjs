/**
 * Pure side-effect-free UI state & formatting helpers for Control Tower Sidecar.
 * Imported directly by browser app.js (ESM) and Node unit tests (L1 gate).
 */

export function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

export function formatWorkspaceLabel(wsPath) {
  const raw = String(wsPath || '').trim();
  if (!raw) return { name: '未绑定工作区', parent: '', display: '未绑定工作区' };
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  const name = parts[parts.length - 1] || raw;
  const parent = parts.length >= 2 ? parts[parts.length - 2] : '';
  return {
    name,
    parent,
    display: parent ? `${name}  (${parent})` : name,
  };
}

export function computeTabVisibility({ tab = 'overview', hasReg = false, hasWorkspace = false } = {}) {
  const alwaysAllowed = tab === 'settings' || tab === 'roadmap';
  const showEmpty = !hasReg && Boolean(hasWorkspace) && !alwaysAllowed;
  const tabs = ['overview', 'sessions', 'roadmap', 'queue', 'raw', 'settings'];
  const visibleTabs = {};
  for (const name of tabs) {
    if (name === 'settings') visibleTabs[name] = tab === 'settings';
    else if (name === 'roadmap') visibleTabs[name] = tab === 'roadmap' && Boolean(hasWorkspace);
    else visibleTabs[name] = Boolean(hasReg) && name === tab;
  }
  return { showEmpty, visibleTabs };
}

export function computePaneChromeState({
  tab = 'overview',
  hasSnapshot = false,
  hasWorkspace = false,
  hasReg = false,
  unreadTotal = 0,
  activeSurfacesCount = 0,
  roadmapDone = 0,
  roadmapTotal = 0,
  queueCount = 0,
} = {}) {
  const showSkeleton = !hasSnapshot;
  const showUnbound = Boolean(hasSnapshot) && !hasWorkspace && tab !== 'settings';
  const needsInitTabs = hasSnapshot && hasWorkspace && !hasReg ? ['sessions', 'queue', 'raw'] : [];
  const unread = Math.max(0, Number(unreadTotal) || 0);
  const act = Math.max(0, Number(activeSurfacesCount) || 0);
  const rDone = Math.max(0, Number(roadmapDone) || 0);
  const rTotal = Math.max(0, Number(roadmapTotal) || 0);
  const qCnt = Math.max(0, Number(queueCount) || 0);

  return {
    showSkeleton,
    showUnbound,
    needsInitTabs,
    emptyTabHint:
      hasSnapshot && hasWorkspace && !hasReg && ['sessions', 'queue', 'raw'].includes(tab)
        ? '完成下方台账初始化后，即可解锁「执行面 / 队列 / 台账」完整视图。'
        : '',
    tabCounts: {
      overview: unread > 0 ? String(unread) : '',
      sessions: hasReg && act > 0 ? String(act) : '',
      roadmap: rTotal > 0 ? `${rDone}/${rTotal}` : '',
      queue: hasReg && qCnt > 0 ? String(qCnt) : '',
    },
  };
}

export function isLeaseIdle(lockStatus, leaseEnabled = true) {
  if (!leaseEnabled) return true;
  return /IDLE|空闲|无独占/i.test(String(lockStatus || ''));
}

export function computeOverviewRestraint({
  leaseEnabled = true,
  lockStatus = '',
  unreadTotal = 0,
} = {}) {
  const idle = isLeaseIdle(lockStatus, leaseEnabled);
  const unread = Math.max(0, Number(unreadTotal) || 0);
  return {
    leaseIdle: idle,
    showReleaseLeaseBtn: Boolean(leaseEnabled) && !idle,
    showFullLeaseGrid: Boolean(leaseEnabled) && !idle,
    canDeliverInbox: unread > 0,
    canAckAllInbox: unread > 0,
  };
}

export function computeControllerHealth({ compactions = 0, threshold = 5, ignored = false } = {}) {
  const comps = Math.max(0, Number(compactions) || 0);
  const thresh = Math.max(1, Number(threshold) || 5);
  const exceeded = !ignored && comps >= thresh;
  return {
    badgeText: ignored ? `压缩 ${comps} 次 (已忽略)` : `压缩 ${comps} / ${thresh} 次`,
    badgeClass: exceeded ? 'badge-danger' : 'badge-ok',
    showAlert: exceeded,
    alertText: `当前总控已累计 ${comps} 次压缩（阈值 ${thresh} 次），可一键拉起新总控接班或忽略。`,
  };
}

export function computeLivePollPlan({
  pluginPollEnabled = true,
  pausedByUser = false,
  intervalSec = 4,
  activeSessionCount = 0,
  swarmActive = false,
  sseConnected = false,
} = {}) {
  const sec = Math.max(2, Math.min(60, Number(intervalSec) || 4));
  const hasActiveWork = Number(activeSessionCount) > 0 || Boolean(swarmActive);
  const isLive = Boolean(pluginPollEnabled) && !pausedByUser;
  if (isLive && sseConnected) {
    return {
      isLive: true,
      dotLive: true,
      buttonText: 'SSE 实时',
      shouldSchedule: hasActiveWork,
      intervalMs: Math.max(sec * 6, 24) * 1000,
      mode: 'sse',
    };
  }
  return {
    isLive,
    dotLive: isLive && hasActiveWork,
    buttonText: isLive ? `监测 ${sec}s` : '监测暂停',
    shouldSchedule: isLive && hasActiveWork,
    intervalMs: sec * 1000,
    mode: isLive ? 'poll' : 'paused',
  };
}

export function nextInlineConfirmState({
  armed = false,
  nowMs = Date.now(),
  expiresAt = 0,
  defaultLabel = '删除',
  confirmLabel = '确认删除?',
  timeoutMs = 3000,
} = {}) {
  if (armed && Number(expiresAt) > nowMs) {
    return {
      execute: true,
      nextArmed: false,
      nextExpiresAt: 0,
      label: defaultLabel,
    };
  }
  return {
    execute: false,
    nextArmed: true,
    nextExpiresAt: nowMs + Math.max(500, Number(timeoutMs) || 3000),
    label: confirmLabel,
  };
}

export function formatGlobalWorkspacesBadge(multiWorkspace) {
  const mw = multiWorkspace && typeof multiWorkspace === 'object' ? multiWorkspace : {};
  const p0 = Number(mw.totalP0 || 0);
  const p1 = Number(mw.totalP1 || 0);
  const count = Number(mw.workspaceCount || 0);
  if (p0 > 0) {
    return { text: `P0:${p0}`, badgeClass: 'badge-danger', hasAlert: true };
  }
  if (p1 > 0) {
    return { text: `P1:${p1}`, badgeClass: 'badge-warn', hasAlert: true };
  }
  return { text: `${count} 仓`, badgeClass: 'badge-muted', hasAlert: false };
}

export function buildPrefilledHandoverText(snap) {
  const raw = snap?.templates?.handoverTemplate || '';
  if (!snap || !snap.registryExists) return raw;
  const ctrl = snap.parsed?.controller || {};
  const eff = snap.settings?.effective || {};
  const nextTerm = (ctrl.handoverHistory?.length || 0) + 1;
  const lease = snap.parsed?.lease || {};
  const activeText =
    (snap.parsed?.activeSessions || [])
      .slice(0, 3)
      .map((s) => `${s.conversationId} (${s.topic})`)
      .join('; ') || '无';
  const swarmPart = snap.nativeSwarm?.active ? ` | Swarm: ${snap.nativeSwarm.title}` : '';
  const settingsSnapshot =
    `${eff.exclusiveLeaseEnabled === false ? '无独占锁' : '单锁开启'} | ` +
    `${eff.effectiveAutonomy || 'balanced'} | 阈值 ${eff.controllerCompactionThreshold || 5} 次`;
  return raw
    .replace('<N>', String(nextTerm))
    .replace('<旧 conversationId>', ctrl.currentControllerId || '<旧 conversationId>')
    .replace(
      '<列出 AGENTS.md / 状态总账 / SESSION-REGISTRY.md（含托管标记）精确路径>',
      snap.registryPath || snap.registryRelPath || 'SESSION-REGISTRY.md'
    )
    .replace(
      '<独占锁开启或关闭 | 代决策档位 autonomous/balanced/strict | 换届阈值 | 生效覆盖文档路径>',
      settingsSnapshot
    )
    .replace(
      '<无独占资源模式 / IDLE / 会话 conversationId（任务编号）>',
      eff.exclusiveLeaseEnabled === false
        ? '无独占资源模式'
        : `${lease.lockStatus || 'IDLE'} | ${lease.holder || '-'}`
    )
    .replace(
      '<列出仍在推进的 conversationId 或活跃原生 swarm 标题与停靠点，没有填 无>',
      `${activeText}${swarmPart}`
    );
}

export function summarizeDiagnosticsBadge(summary) {
  if (!summary || typeof summary !== 'object') {
    return { text: '未加载', badgeClass: 'badge-muted' };
  }
  const errs = Number(summary.byLevel?.error || 0);
  const warns = Number(summary.byLevel?.warn || 0);
  if (errs > 0) {
    return { text: `${errs} 错误 / ${warns} 警告`, badgeClass: 'badge-danger' };
  }
  if (warns > 0) {
    return { text: `0 错误 / ${warns} 警告`, badgeClass: 'badge-warn' };
  }
  return { text: `健康 (${Number(summary.total || 0)} 条)`, badgeClass: 'badge-ok' };
}

export function formatFlightEventRow(ev) {
  const ts = String(ev?.ts || '');
  const timeLabel = ts.length >= 19 ? ts.slice(11, 19) : ts || '-';
  const level = ev?.level === 'error' || ev?.level === 'warn' ? ev.level : 'info';
  const levelClass = level === 'error' ? 'badge-danger' : level === 'warn' ? 'badge-warn' : 'badge-muted';
  const parts = [ev?.source || 'core', ev?.event || 'event'];
  if (ev?.conv) parts.push(`#${ev.conv}`);
  if (Number.isFinite(ev?.durationMs)) parts.push(`${ev.durationMs}ms`);
  return {
    timeLabel,
    level,
    levelClass,
    title: parts.join(' | '),
    message: ev?.message || (ev?.detail ? JSON.stringify(ev.detail) : ''),
  };
}

export function formatFocusGateBadge(focus) {
  const mode = focus?.mode || 'idle';
  if (mode === 'in_flight') {
    return { text: '回复中 (防打扰)', badgeClass: 'badge-warn' };
  }
  if (mode === 'focused') {
    const sec = Number(focus?.remainingCooldownSec || 0);
    return { text: `前台聚焦防打扰 (${sec}s)`, badgeClass: 'badge-warn' };
  }
  return { text: '空闲可唤醒', badgeClass: 'badge-ok' };
}

export function formatInboxPriorityClass(priority) {
  const p = String(priority || 'P2').toUpperCase();
  if (p === 'P0') return 'badge-danger';
  if (p === 'P1') return 'badge-warn';
  return 'badge-muted';
}

export function summarizeExecutionSurfaces(surfaces) {
  const s = surfaces && typeof surfaces === 'object' ? surfaces : {};
  const swarmAlive = (s.swarm?.members || []).filter((m) => m.state !== 'killed').length;
  const subagents = Array.isArray(s.subagents) ? s.subagents.length : 0;
  const workflows = Array.isArray(s.workflows) ? s.workflows.length : 0;
  const topLevel = Array.isArray(s.topLevel) ? s.topLevel.length : 0;
  return {
    swarm: swarmAlive,
    subagents,
    workflows,
    topLevel,
    hiddenTotal: swarmAlive + subagents + workflows,
    totalActive: swarmAlive + subagents + workflows + topLevel,
    sidebarWarning: topLevel >= 3,
  };
}

export function formatRoadmapStatusBadge(effectiveStatus) {
  switch (String(effectiveStatus || 'planned').toLowerCase()) {
    case 'ready':
      return { text: 'READY 就绪', badgeClass: 'badge-ok' };
    case 'active':
      return { text: 'ACTIVE 推进中', badgeClass: 'badge-warn' };
    case 'blocked':
      return { text: 'BLOCKED 等前置', badgeClass: 'badge-danger' };
    case 'verified':
      return { text: 'VERIFIED 已验', badgeClass: 'badge-ok' };
    case 'done':
      return { text: 'DONE 已结项', badgeClass: 'badge-muted' };
    default:
      return { text: 'PLANNED', badgeClass: 'badge-muted' };
  }
}

export function formatIsolationLabel(mode) {
  if (mode === 'branch') return 'branch (独立克隆)';
  if (mode === 'inherit') return 'inherit (共享目录)';
  return 'share (独立工作树)';
}

export function formatCollabLabel(mode) {
  if (mode === 'workflow_pipeline') return 'Workflow 流水线';
  if (mode === 'handoff_file') return '契约文件接力';
  if (mode === 'solo') return '独立单线';
  return 'Swarm 频道直聊';
}

export const MODEL_SELECT_GROUPS = Object.freeze([
  {
    label: '新版 Orchestrator（规划 + 执行双层）',
    options: [
      { value: 'Orchestrator (Neon Extra High)', label: 'Orchestrator (Neon Extra High) [主力开发/Swarm]' },
      { value: 'Orchestrator (Carbon)', label: 'Orchestrator (Carbon) [L3 跨层攻坚]' },
      { value: 'Orchestrator (Neon)', label: 'Orchestrator (Neon)' },
    ],
  },
  {
    label: '纯 Gemini 4 单模型（满思考首选）',
    options: [
      { value: 'Gemini 4 Neon (XHigh)', label: 'Gemini 4 Neon (XHigh) [L0 常驻总控首选]' },
      { value: 'Gemini 4 Hydrogen (XHigh)', label: 'Gemini 4 Hydrogen (XHigh) [L1 极速扫描/轻验]' },
      { value: 'Gemini 4 Carbon (High)', label: 'Gemini 4 Carbon (High) [连续深推]' },
    ],
  },
  {
    label: '纯 Gemini 4 降档备选（限流/配额紧张）',
    options: [
      { value: 'Gemini 4 Neon (High)', label: 'Gemini 4 Neon (High)' },
      { value: 'Gemini 4 Hydrogen (High)', label: 'Gemini 4 Hydrogen (High)' },
      { value: 'Gemini 4 Carbon (Medium)', label: 'Gemini 4 Carbon (Medium)' },
      { value: 'Gemini 4 Neon (Medium)', label: 'Gemini 4 Neon (Medium)' },
      { value: 'Gemini 4 Hydrogen (Medium)', label: 'Gemini 4 Hydrogen (Medium)' },
      { value: 'Gemini 4 Hydrogen (Low)', label: 'Gemini 4 Hydrogen (Low)' },
    ],
  },
]);

export const QUEUE_ROUTE_PRESETS = Object.freeze([
  { value: 'L1 Gemini 4 Hydrogen (XHigh)', label: 'L1 轻量扫描 - Gemini 4 Hydrogen (XHigh)' },
  { value: 'L2 Orchestrator (Neon Extra High)', label: 'L2 常规开发 - Orchestrator (Neon Extra High)' },
  { value: 'L2 Gemini 4 Neon (XHigh)', label: 'L2 单模开发 - Gemini 4 Neon (XHigh)' },
  { value: 'L3 Orchestrator (Carbon)', label: 'L3 疑难攻坚 - Orchestrator (Carbon)' },
  { value: 'L3 Gemini 4 Carbon (High)', label: 'L3 连续深推 - Gemini 4 Carbon (High)' },
  { value: 'L4 Orchestrator (Neon Extra High)', label: 'L4 集成发布 - Orchestrator (Neon Extra High)' },
]);

const CLI_ID_TO_PRESET = new Map([
  ['gemini-pro-orchestrator-neon', 'Orchestrator (Neon Extra High)'],
  ['gemini-pro-orchestrator', 'Orchestrator (Carbon)'],
  ['gemini-4-neon-xhigh', 'Gemini 4 Neon (XHigh)'],
  ['gemini-4-hydrogen-xhigh', 'Gemini 4 Hydrogen (XHigh)'],
  ['gemini-4-carbon-high', 'Gemini 4 Carbon (High)'],
  ['gemini-4-neon-high', 'Gemini 4 Neon (High)'],
  ['gemini-4-hydrogen-high', 'Gemini 4 Hydrogen (High)'],
  ['gemini-4-carbon-medium', 'Gemini 4 Carbon (Medium)'],
  ['gemini-4-neon-medium', 'Gemini 4 Neon (Medium)'],
  ['gemini-4-hydrogen-medium', 'Gemini 4 Hydrogen (Medium)'],
  ['gemini-4-hydrogen-low', 'Gemini 4 Hydrogen (Low)'],
]);

export function canonicalizePresetModel(rawVal) {
  const clean = String(rawVal ?? '').replace(/^`+|`+$/g, '').trim();
  if (!clean) return '';
  const lower = clean.toLowerCase();
  if (CLI_ID_TO_PRESET.has(lower)) return CLI_ID_TO_PRESET.get(lower);
  for (const grp of MODEL_SELECT_GROUPS) {
    for (const opt of grp.options) {
      if (opt.value.toLowerCase() === lower) return opt.value;
    }
  }
  return clean;
}

export function buildModelSelectOptionsHtml({
  mode = 'standard',
  inheritLabel = '继承全局设置',
  extraModels = [],
} = {}) {
  const parts = [];
  if (mode === 'inherit') {
    parts.push(`<option value="" data-inherit-opt="1">${escHtml(inheritLabel)}</option>`);
  }
  if (mode === 'route') {
    parts.push('<optgroup label="标准分层调度路线">');
    for (const opt of QUEUE_ROUTE_PRESETS) {
      parts.push(`<option value="${escHtml(opt.value)}">${escHtml(opt.label)}</option>`);
    }
    parts.push('</optgroup>');
    parts.push('<optgroup label="扩展 / 自定义"><option value="__custom__">自定义路线与模型...</option></optgroup>');
    return parts.join('');
  }

  const presetLower = new Set();
  for (const grp of MODEL_SELECT_GROUPS) {
    parts.push(`<optgroup label="${escHtml(grp.label)}">`);
    for (const opt of grp.options) {
      presetLower.add(opt.value.toLowerCase());
      parts.push(`<option value="${escHtml(opt.value)}">${escHtml(opt.label)}</option>`);
    }
    parts.push('</optgroup>');
  }

  const extras = (Array.isArray(extraModels) ? extraModels : [])
    .map((m) => String(m || '').trim())
    .filter((m) => m && !presetLower.has(m.toLowerCase()));
  if (extras.length > 0) {
    parts.push('<optgroup label="自定义白名单模型">');
    for (const m of extras) {
      parts.push(`<option value="${escHtml(m)}">${escHtml(m)}</option>`);
    }
    parts.push('</optgroup>');
  }

  parts.push('<optgroup label="扩展 / 自定义"><option value="__custom__">自定义模型名称 / ID...</option></optgroup>');
  return parts.join('');
}

export function resolveModelSelectState(
  rawVal,
  { mode = 'standard', extraModels = [], fallback = '' } = {}
) {
  const raw = String(rawVal ?? '').replace(/^`+|`+$/g, '').trim();
  if (mode === 'inherit' && !raw) {
    return { selectValue: '', customValue: '', showCustom: false };
  }
  if (mode === 'route') {
    const target = raw || fallback || 'L2 Orchestrator (Neon Extra High)';
    const hit = QUEUE_ROUTE_PRESETS.find((p) => p.value.toLowerCase() === target.toLowerCase());
    if (hit) {
      return { selectValue: hit.value, customValue: '', showCustom: false };
    }
    return { selectValue: '__custom__', customValue: target, showCustom: true };
  }

  const target = canonicalizePresetModel(raw || fallback || 'Orchestrator (Neon Extra High)');
  const lower = target.toLowerCase();
  for (const grp of MODEL_SELECT_GROUPS) {
    const hit = grp.options.find((o) => o.value.toLowerCase() === lower);
    if (hit) {
      return { selectValue: hit.value, customValue: '', showCustom: false };
    }
  }
  for (const ex of Array.isArray(extraModels) ? extraModels : []) {
    const cleanEx = String(ex || '').trim();
    if (cleanEx && cleanEx.toLowerCase() === lower) {
      return { selectValue: cleanEx, customValue: '', showCustom: false };
    }
  }
  return { selectValue: '__custom__', customValue: raw || target, showCustom: true };
}
