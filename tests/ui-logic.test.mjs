import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPrefilledHandoverText,
  computeControllerHealth,
  computeLivePollPlan,
  computeTabVisibility,
  escHtml,
  formatFlightEventRow,
  isLeaseIdle,
  summarizeDiagnosticsBadge,
} from '../plugin/sidecars/tower/ui-logic.mjs';
import { makeConvId } from './helpers.mjs';

test('ui-logic: tab visibility, lease idle detection, and controller health badge', () => {
  assert.deepEqual(computeTabVisibility({ tab: 'overview', hasReg: false, hasWorkspace: true }), {
    showEmpty: true,
    visibleTabs: { overview: false, sessions: false, queue: false, raw: false, settings: false },
  });

  // Settings tab stays accessible even when workspace has no registry yet
  assert.deepEqual(computeTabVisibility({ tab: 'settings', hasReg: false, hasWorkspace: true }), {
    showEmpty: false,
    visibleTabs: { overview: false, sessions: false, queue: false, raw: false, settings: true },
  });

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
