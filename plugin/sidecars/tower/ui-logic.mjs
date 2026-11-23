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

export function isLeaseIdle(lockStatus, leaseEnabled = true) {
  if (!leaseEnabled) return true;
  return /IDLE|空闲|无独占/i.test(String(lockStatus || ''));
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
} = {}) {
  const sec = Math.max(2, Math.min(60, Number(intervalSec) || 4));
  const hasActiveWork = Number(activeSessionCount) > 0 || Boolean(swarmActive);
  const isLive = Boolean(pluginPollEnabled) && !pausedByUser;
  return {
    isLive,
    dotLive: isLive && hasActiveWork,
    buttonText: isLive ? `监测 ${sec}s` : '监测暂停',
    shouldSchedule: isLive && hasActiveWork,
    intervalMs: sec * 1000,
  };
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
    return { text: '前台回复中 (防打扰)', badgeClass: 'badge-warn' };
  }
  if (mode === 'focused') {
    const sec = Number(focus?.remainingCooldownSec || 0);
    return { text: `前台聚焦防打扰 (${sec}s)`, badgeClass: 'badge-warn' };
  }
  return { text: '空闲待命 (可唤醒)', badgeClass: 'badge-ok' };
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
    sidebarWarning: topLevel >= 3,
  };
}

export function formatRoadmapStatusBadge(effectiveStatus) {
  switch (String(effectiveStatus || 'planned').toLowerCase()) {
    case 'ready':
      return { text: 'READY 可并行', badgeClass: 'badge-ok' };
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
  if (mode === 'workflow_pipeline') return 'Workflow 契约流水线';
  if (mode === 'handoff_file') return '契约文件接力';
  if (mode === 'solo') return '独立单线';
  return 'Swarm 频道直聊';
}
