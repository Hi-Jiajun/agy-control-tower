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
  const showEmpty = !hasReg && Boolean(hasWorkspace) && tab !== 'settings';
  const tabs = ['overview', 'sessions', 'queue', 'raw', 'settings'];
  const visibleTabs = {};
  for (const name of tabs) {
    visibleTabs[name] = name === 'settings' ? tab === 'settings' : Boolean(hasReg) && name === tab;
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
