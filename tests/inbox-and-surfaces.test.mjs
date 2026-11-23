import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  ackInboxItems,
  buildInboxDigestLine,
  evaluateFocusGate,
  evaluateSentinelSweep,
  loadWorkspaceInbox,
  recordControllerFocus,
  summarizeInbox,
  upsertInboxItem,
} from '../plugin/lib/inbox.mjs';
import { inspectHiddenSurfaces } from '../plugin/lib/transcript.mjs';
import {
  formatFocusGateBadge,
  formatInboxPriorityClass,
  summarizeExecutionSurfaces,
} from '../plugin/sidecars/tower/ui-logic.mjs';
import { makeConvId, makeSandbox, makeTranscriptPath } from './helpers.mjs';

test('Phase 2: Inbox Focus Gate, priority ordering, passive digest, and zero-token sentinel sweep work cleanly', () => {
  const sb = makeSandbox('ct-inbox-');
  try {
    const dataDir = join(sb.dir, 'plugin_data');
    const ws = join(sb.dir, 'ws');
    mkdirSync(ws, { recursive: true });

    // Read-only load never creates plugin_data
    const empty = loadWorkspaceInbox(dataDir, ws);
    assert.equal(empty.items.length, 0);
    assert.equal(existsSync(dataDir), false);

    const now = 1_700_000_000_000;
    recordControllerFocus(dataDir, ws, {
      controllerId: makeConvId('c', '1', '4', '8', 'a'),
      inFlight: true,
      lastUserInputAt: now,
      nowMs: now,
    });

    const inFlightGate = evaluateFocusGate(loadWorkspaceInbox(dataDir, ws).focus, {
      nowMs: now + 5000,
      focusCooldownSec: 180,
    });
    assert.equal(inFlightGate.mode, 'in_flight');
    assert.equal(inFlightGate.isForegroundBusy, true);
    assert.equal(inFlightGate.shouldInterruptFor('P0'), false);

    recordControllerFocus(dataDir, ws, { inFlight: false, lastTurnEndAt: now + 10_000, nowMs: now + 10_000 });
    const focusedGate = evaluateFocusGate(loadWorkspaceInbox(dataDir, ws).focus, {
      nowMs: now + 60_000,
      focusCooldownSec: 180,
    });
    assert.equal(focusedGate.mode, 'focused');
    assert.equal(focusedGate.isForegroundBusy, true);
    assert.equal(focusedGate.shouldInterruptFor('P2'), false);
    assert.ok(formatFocusGateBadge(focusedGate).text.includes('前台聚焦防打扰'));

    const idleGate = evaluateFocusGate(loadWorkspaceInbox(dataDir, ws).focus, {
      nowMs: now + 300_000,
      focusCooldownSec: 180,
    });
    assert.equal(idleGate.mode, 'idle');
    assert.equal(idleGate.isForegroundBusy, false);
    assert.equal(idleGate.shouldInterruptFor('P1'), true);
    assert.equal(idleGate.shouldInterruptFor('P2'), false);

    // Zero-token sentinel detects error (P0), stuck (P1), compaction (P2), and done-unarchived (P2)
    const wErr = makeConvId('a', '1', '4', '8', '1');
    const wStuck = makeConvId('b', '2', '4', '8', '2');
    const sweep = evaluateSentinelSweep({
      dataDir,
      wsReal: ws,
      workerCompactionThreshold: 2,
      stuckThresholdMin: 15,
      nowMs: now + 40 * 60 * 1000,
      activeSessions: [
        {
          conversationId: wErr,
          topic: '编译模块A',
          status: 'ACTIVE',
          telemetry: {
            exists: true,
            maxStepIndex: 12,
            compactions: 2,
            lastStatus: 'ERROR',
            lastError: 'TypeError: boom',
            lastUpdatedAt: new Date(now + 39 * 60 * 1000).toISOString(),
          },
        },
        {
          conversationId: wStuck,
          topic: '集成测试B',
          status: 'ACTIVE',
          telemetry: {
            exists: true,
            maxStepIndex: 5,
            compactions: 0,
            lastStatus: 'RUNNING',
            lastError: '',
            lastUpdatedAt: new Date(now + 10 * 60 * 1000).toISOString(),
          },
        },
      ],
    });

    assert.equal(sweep.detectedCount, 3);
    const summary = summarizeInbox(sweep.inbox, { nowMs: now + 40 * 60 * 1000, focusCooldownSec: 180 });
    assert.equal(summary.unreadCounts.P0, 1);
    assert.equal(summary.unreadCounts.P1, 1);
    assert.equal(summary.unreadCounts.P2, 1);
    assert.equal(summary.items[0].priority, 'P0');
    assert.equal(formatInboxPriorityClass('P0'), 'badge-danger');

    const digestP0 = buildInboxDigestLine(sweep.inbox);
    assert.ok(digestP0.includes('[control-tower 收件箱 P0 提醒]'));

    // Ack P0 -> digest downgrades to passive silent digest
    const afterAckP0 = ackInboxItems(dataDir, ws, { priority: 'P0' });
    const digestSilent = buildInboxDigestLine(afterAckP0);
    assert.ok(digestSilent.includes('[control-tower 后台信箱静默摘要]'));

    // Deduplication check: repeated sweep does not double-add items
    upsertInboxItem(dataDir, ws, {
      dedupKey: `sentinel:stuck:${wStuck.slice(0, 8)}:5`,
      priority: 'P1',
      title: 'duplicate',
      summary: 'same',
      reopenOnUpdate: false,
    });
    assert.equal(loadWorkspaceInbox(dataDir, ws).items.length, 3);
  } finally {
    sb.cleanup();
  }
});

test('Phase 2: inspectHiddenSurfaces aggregates invoke_subagent and run_workflow from controller tail', () => {
  const sb = makeSandbox('ct-surfaces-');
  try {
    const appData = join(sb.dir, 'app_data');
    const ctrlId = makeConvId('c', '1', '4', '8', 'a');
    const subId = makeConvId('d', '2', '4', '8', 'b');
    const subId2 = makeConvId('e', '3', '4', '9', 'c');

    writeFileSync(
      makeTranscriptPath(appData, subId),
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'Inspect module' }),
        JSON.stringify({ step_index: 4, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high', status: 'DONE' }),
      ].join('\n') + '\n',
      'utf8'
    );
    writeFileSync(
      makeTranscriptPath(appData, subId2),
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'Inspect security' }),
        JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', model: 'gemini-4-carbon-high', status: 'RUNNING' }),
      ].join('\n') + '\n',
      'utf8'
    );

    writeFileSync(
      makeTranscriptPath(appData, ctrlId),
      [
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-23T12:00:00Z',
          tool_calls: [
            {
              name: 'invoke_subagent',
              args: { TypeName: 'research', Role: 'Code Auditor', Model: 'inherit', Workspace: 'inherit' },
            },
            {
              name: 'invoke_subagent',
              args: { TypeName: 'research', Role: 'Security Auditor', Model: 'inherit', Workspace: 'inherit' },
            },
          ],
        }),
        JSON.stringify({
          step_index: 2,
          type: 'GENERIC',
          status: 'DONE',
          content: `Launched subagent conversationId=${subId}`,
        }),
        JSON.stringify({
          step_index: 3,
          type: 'GENERIC',
          status: 'DONE',
          content: `Launched subagent conversationId=${subId2}`,
        }),
        JSON.stringify({
          step_index: 4,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-23T12:02:00Z',
          tool_calls: [
            {
              name: 'run_workflow',
              args: { Description: 'Batch lint & test fanout', ScriptPath: 'fanout.py' },
            },
          ],
        }),
        JSON.stringify({
          step_index: 5,
          type: 'GENERIC',
          status: 'DONE',
          content: 'Workflow completed',
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const hidden = inspectHiddenSurfaces(ctrlId, { env: { ANTIGRAVITY_APP_DATA_DIR: appData } });
    assert.equal(hidden.subagents.length, 2);
    assert.equal(hidden.subagents[0].role, 'Security Auditor');
    assert.equal(hidden.subagents[0].conversationId, subId2);
    assert.equal(hidden.subagents[1].role, 'Code Auditor');
    assert.equal(hidden.subagents[1].conversationId, subId);
    assert.equal(hidden.subagents[1].steps, 4);
    assert.equal(hidden.workflows.length, 1);
    assert.equal(hidden.workflows[0].description, 'Batch lint & test fanout');

    const sum = summarizeExecutionSurfaces({
      swarm: { active: true, members: [{ name: 'w1', state: 'working' }, { name: 'w2', state: 'killed' }] },
      subagents: hidden.subagents,
      workflows: hidden.workflows,
      topLevel: [{ conversationId: '1' }, { conversationId: '2' }, { conversationId: '3' }],
    });
    assert.equal(sum.swarm, 1);
    assert.equal(sum.hiddenTotal, 4);
    assert.equal(sum.sidebarWarning, true);
  } finally {
    sb.cleanup();
  }
});
