import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModelSelectOptionsHtml,
  buildPrefilledHandoverText,
  canonicalizePresetModel,
  computeControllerHealth,
  computeLivePollPlan,
  computeOverviewRestraint,
  computePaneChromeState,
  computeTabVisibility,
  escHtml,
  formatCollabLabel,
  formatFlightEventRow,
  formatGlobalWorkspacesBadge,
  formatIsolationLabel,
  formatRoadmapStatusBadge,
  formatWorkspaceLabel,
  isLeaseIdle,
  nextInlineConfirmState,
  resolveModelSelectState,
  summarizeDiagnosticsBadge,
  summarizeExecutionSurfaces,
} from '../plugin/sidecars/tower/ui-logic.mjs';
import { makeConvId } from './helpers.mjs';

test('ui-logic: tab visibility, lease idle detection, and controller health badge', () => {
  assert.deepEqual(computeTabVisibility({ tab: 'overview', hasReg: false, hasWorkspace: true }), {
    showEmpty: true,
    visibleTabs: { overview: false, sessions: false, roadmap: false, queue: false, raw: false, settings: false },
  });

  // Settings & roadmap tabs stay accessible even when workspace has no registry yet
  assert.deepEqual(computeTabVisibility({ tab: 'settings', hasReg: false, hasWorkspace: true }), {
    showEmpty: false,
    visibleTabs: { overview: false, sessions: false, roadmap: false, queue: false, raw: false, settings: true },
  });
  assert.deepEqual(computeTabVisibility({ tab: 'roadmap', hasReg: false, hasWorkspace: true }), {
    showEmpty: false,
    visibleTabs: { overview: false, sessions: false, roadmap: true, queue: false, raw: false, settings: false },
  });
  assert.equal(formatRoadmapStatusBadge('ready').badgeClass, 'badge-ok');
  assert.equal(formatRoadmapStatusBadge('blocked').badgeClass, 'badge-danger');
  assert.ok(formatIsolationLabel('share').includes('share'));
  assert.ok(formatCollabLabel('handoff_file').includes('契约'));

  assert.equal(isLeaseIdle('IDLE（空闲待分配）', true), true);
  assert.equal(isLeaseIdle('LOCKED 持锁中', true), false);
  assert.equal(isLeaseIdle('LOCKED 持锁中', false), true);

  const healthy = computeControllerHealth({ compactions: 2, threshold: 5, ignored: false });
  assert.equal(healthy.showAlert, false);
  assert.equal(healthy.badgeClass, 'badge-ok');

  const aged = computeControllerHealth({ compactions: 5, threshold: 5, ignored: false });
  assert.equal(aged.showAlert, true);
  assert.equal(aged.badgeClass, 'badge-danger');

  const ignored = computeControllerHealth({ compactions: 8, threshold: 5, ignored: true });
  assert.equal(ignored.showAlert, false);
  assert.ok(ignored.badgeText.includes('已忽略'));
});

test('ui-logic: live poll plan, HTML escaping, prefilled handover, and diagnostics formatters', () => {
  const activePlan = computeLivePollPlan({
    pluginPollEnabled: true,
    pausedByUser: false,
    intervalSec: 4,
    activeSessionCount: 1,
    swarmActive: false,
  });
  assert.equal(activePlan.shouldSchedule, true);
  assert.equal(activePlan.dotLive, true);
  assert.equal(activePlan.intervalMs, 4000);

  const idlePlan = computeLivePollPlan({
    pluginPollEnabled: true,
    pausedByUser: false,
    intervalSec: 4,
    activeSessionCount: 0,
    swarmActive: false,
  });
  assert.equal(idlePlan.shouldSchedule, false);
  assert.equal(idlePlan.dotLive, false);

  assert.equal(escHtml('<script>"a&b\'</script>'), '&lt;script&gt;&quot;a&amp;b&#39;&lt;/script&gt;');

  const ctrlId = makeConvId('c', '1', '4', '8', 'a');
  const handover = buildPrefilledHandoverText({
    registryExists: true,
    registryRelPath: '.agents/SESSION-REGISTRY.md',
    templates: {
      handoverTemplate: '第 <N> 任 | 旧: <旧 conversationId> | 锁: <无独占资源模式 / IDLE / 会话 conversationId（任务编号）>',
    },
    parsed: {
      controller: { currentControllerId: ctrlId, handoverHistory: [{ term: '1' }] },
      lease: { lockStatus: 'IDLE', holder: '-' },
      activeSessions: [],
    },
    settings: { effective: { exclusiveLeaseEnabled: false, effectiveAutonomy: 'balanced', controllerCompactionThreshold: 5 } },
  });
  assert.ok(handover.includes('第 2 任'));
  assert.ok(handover.includes(ctrlId));
  assert.ok(handover.includes('无独占资源模式'));

  assert.equal(summarizeDiagnosticsBadge({ total: 3, byLevel: { error: 0, warn: 0 } }).badgeClass, 'badge-ok');
  assert.equal(summarizeDiagnosticsBadge({ total: 3, byLevel: { error: 0, warn: 2 } }).badgeClass, 'badge-warn');
  assert.equal(summarizeDiagnosticsBadge({ total: 3, byLevel: { error: 1, warn: 2 } }).badgeClass, 'badge-danger');

  const row = formatFlightEventRow({
    ts: '2026-11-23T12:34:56.000Z',
    level: 'warn',
    source: 'hook',
    event: 'slow_hook',
    conv: 'aabbccdd',
    durationMs: 142,
    message: 'Hook took 142ms',
  });
  assert.equal(row.timeLabel, '12:34:56');
  assert.equal(row.levelClass, 'badge-warn');
  assert.ok(row.title.includes('slow_hook') && row.title.includes('142ms'));
});

test('ui-logic (v1.7.0): SSE live poll mode, inline 2-step confirm state machine, and global workspace badge', () => {
  const ssePlan = computeLivePollPlan({
    pluginPollEnabled: true,
    pausedByUser: false,
    intervalSec: 4,
    activeSessionCount: 1,
    swarmActive: false,
    sseConnected: true,
  });
  assert.equal(ssePlan.mode, 'sse');
  assert.equal(ssePlan.buttonText, 'SSE 实时');
  assert.equal(ssePlan.dotLive, true);
  assert.equal(ssePlan.shouldSchedule, true);
  assert.equal(ssePlan.intervalMs, 24000);

  const pausedSsePlan = computeLivePollPlan({
    pluginPollEnabled: true,
    pausedByUser: true,
    intervalSec: 4,
    activeSessionCount: 1,
    sseConnected: true,
  });
  assert.equal(pausedSsePlan.mode, 'paused');
  assert.equal(pausedSsePlan.buttonText, '监测暂停');

  const step1 = nextInlineConfirmState({
    armed: false,
    nowMs: 1000,
    expiresAt: 0,
    defaultLabel: '删除',
    confirmLabel: '确认删除?',
    timeoutMs: 3000,
  });
  assert.deepEqual(step1, {
    execute: false,
    nextArmed: true,
    nextExpiresAt: 4000,
    label: '确认删除?',
  });

  const step2Exec = nextInlineConfirmState({
    armed: step1.nextArmed,
    nowMs: 2500,
    expiresAt: step1.nextExpiresAt,
    defaultLabel: '删除',
    confirmLabel: '确认删除?',
    timeoutMs: 3000,
  });
  assert.deepEqual(step2Exec, {
    execute: true,
    nextArmed: false,
    nextExpiresAt: 0,
    label: '删除',
  });

  const stepExpired = nextInlineConfirmState({
    armed: true,
    nowMs: 4500,
    expiresAt: 4000,
    defaultLabel: '重置',
    confirmLabel: '确认重置?',
    timeoutMs: 3000,
  });
  assert.equal(stepExpired.execute, false);
  assert.equal(stepExpired.nextArmed, true);
  assert.equal(stepExpired.nextExpiresAt, 7500);
  assert.equal(stepExpired.label, '确认重置?');

  assert.deepEqual(formatGlobalWorkspacesBadge({ totalP0: 2, totalP1: 1, workspaceCount: 3 }), {
    text: 'P0:2',
    badgeClass: 'badge-danger',
    hasAlert: true,
  });
  assert.deepEqual(formatGlobalWorkspacesBadge({ totalP0: 0, totalP1: 3, workspaceCount: 3 }), {
    text: 'P1:3',
    badgeClass: 'badge-warn',
    hasAlert: true,
  });
  assert.deepEqual(formatGlobalWorkspacesBadge({ totalP0: 0, totalP1: 0, workspaceCount: 2 }), {
    text: '2 仓',
    badgeClass: 'badge-muted',
    hasAlert: false,
  });
});

test('ui-logic (v1.10.0): workspace short label, pane chrome skeleton/unbound/counts, and overview restraint', () => {
  assert.deepEqual(formatWorkspaceLabel(''), {
    name: '未绑定工作区',
    parent: '',
    display: '未绑定工作区',
  });
  assert.deepEqual(formatWorkspaceLabel('/srv/projects/AntigravityPlugins/control-tower'), {
    name: 'control-tower',
    parent: 'AntigravityPlugins',
    display: 'control-tower  (AntigravityPlugins)',
  });
  assert.deepEqual(formatWorkspaceLabel('D:\\Workspaces\\AntigravityPlugins\\control-tower\\'), {
    name: 'control-tower',
    parent: 'AntigravityPlugins',
    display: 'control-tower  (AntigravityPlugins)',
  });

  const bootChrome = computePaneChromeState({ hasSnapshot: false });
  assert.equal(bootChrome.showSkeleton, true);
  assert.equal(bootChrome.showUnbound, false);

  const unboundChrome = computePaneChromeState({
    tab: 'overview',
    hasSnapshot: true,
    hasWorkspace: false,
  });
  assert.equal(unboundChrome.showSkeleton, false);
  assert.equal(unboundChrome.showUnbound, true);

  const unboundSettingsChrome = computePaneChromeState({
    tab: 'settings',
    hasSnapshot: true,
    hasWorkspace: false,
  });
  assert.equal(unboundSettingsChrome.showUnbound, false);

  const uninitSessionsChrome = computePaneChromeState({
    tab: 'sessions',
    hasSnapshot: true,
    hasWorkspace: true,
    hasReg: false,
    roadmapDone: 1,
    roadmapTotal: 3,
  });
  assert.deepEqual(uninitSessionsChrome.needsInitTabs, ['sessions', 'queue', 'raw']);
  assert.ok(uninitSessionsChrome.emptyTabHint.includes('完成下方台账初始化后'));
  assert.equal(uninitSessionsChrome.tabCounts.roadmap, '1/3');
  assert.equal(uninitSessionsChrome.tabCounts.sessions, '');

  const activeChrome = computePaneChromeState({
    tab: 'overview',
    hasSnapshot: true,
    hasWorkspace: true,
    hasReg: true,
    unreadTotal: 2,
    activeSurfacesCount: 4,
    roadmapDone: 2,
    roadmapTotal: 5,
    queueCount: 3,
  });
  assert.deepEqual(activeChrome.needsInitTabs, []);
  assert.equal(activeChrome.emptyTabHint, '');
  assert.deepEqual(activeChrome.tabCounts, {
    overview: '2',
    sessions: '4',
    roadmap: '2/5',
    queue: '3',
  });

  const surf = summarizeExecutionSurfaces({
    swarm: { members: [{ state: 'working' }, { state: 'killed' }] },
    subagents: [{}],
    workflows: [],
    topLevel: [{}, {}],
  });
  assert.equal(surf.hiddenTotal, 2);
  assert.equal(surf.totalActive, 4);

  const idleRestraint = computeOverviewRestraint({
    leaseEnabled: true,
    lockStatus: 'IDLE（空闲待分配）',
    unreadTotal: 0,
  });
  assert.deepEqual(idleRestraint, {
    leaseIdle: true,
    showReleaseLeaseBtn: false,
    showFullLeaseGrid: false,
    canDeliverInbox: false,
    canAckAllInbox: false,
  });

  const heldRestraint = computeOverviewRestraint({
    leaseEnabled: true,
    lockStatus: 'LOCKED (独占验证中)',
    unreadTotal: 3,
  });
  assert.deepEqual(heldRestraint, {
    leaseIdle: false,
    showReleaseLeaseBtn: true,
    showFullLeaseGrid: true,
    canDeliverInbox: true,
    canAckAllInbox: true,
  });

  // Model select helpers (preset canonicalization, inherit mode, route mode, custom allowlist & custom input)
  assert.equal(canonicalizePresetModel('`gemini-4-neon-xhigh`'), 'Gemini 4 Neon (XHigh)');
  assert.equal(canonicalizePresetModel('gemini-pro-orchestrator-neon'), 'Orchestrator (Neon Extra High)');
  assert.equal(canonicalizePresetModel('gemini-pro-orchestrator'), 'Orchestrator (Carbon)');

  assert.deepEqual(resolveModelSelectState('Gemini 4 Neon (XHigh)', { mode: 'standard' }), {
    selectValue: 'Gemini 4 Neon (XHigh)',
    customValue: '',
    showCustom: false,
  });
  assert.deepEqual(resolveModelSelectState('', { mode: 'inherit' }), {
    selectValue: '',
    customValue: '',
    showCustom: false,
  });
  assert.deepEqual(
    resolveModelSelectState('custom-corp-v4', { mode: 'standard', extraModels: ['custom-corp-v4'] }),
    {
      selectValue: 'custom-corp-v4',
      customValue: '',
      showCustom: false,
    }
  );
  assert.deepEqual(resolveModelSelectState('Orchestrator (Neon) + /plan', { mode: 'standard' }), {
    selectValue: '__custom__',
    customValue: 'Orchestrator (Neon) + /plan',
    showCustom: true,
  });
  assert.deepEqual(resolveModelSelectState('L3 Orchestrator (Carbon)', { mode: 'route' }), {
    selectValue: 'L3 Orchestrator (Carbon)',
    customValue: '',
    showCustom: false,
  });
  assert.deepEqual(resolveModelSelectState('L2 Custom Route', { mode: 'route' }), {
    selectValue: '__custom__',
    customValue: 'L2 Custom Route',
    showCustom: true,
  });

  const inheritHtml = buildModelSelectOptionsHtml({
    mode: 'inherit',
    inheritLabel: '继承全局 (Gemini 4 Neon (XHigh))',
    extraModels: ['custom-corp-v4'],
  });
  assert.ok(inheritHtml.includes('继承全局 (Gemini 4 Neon (XHigh))'));
  assert.ok(inheritHtml.includes('custom-corp-v4'));
  assert.ok(inheritHtml.includes('value="__custom__"'));
});
