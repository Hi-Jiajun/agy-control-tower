import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  archiveActiveSession,
  deleteQueueRow,
  extractTemplates,
  extractTemplatesFromMarkdown,
  isActiveController,
  parseRegistry,
  updateControllerSection,
  updateLeaseSection,
  upsertActiveSessionRow,
  upsertQueueRow,
} from '../plugin/lib/registry.mjs';
import { makeConvId } from './helpers.mjs';

test('registry parses and mutates Sections 1..5 cleanly while sanitizing markdown pipes', () => {
  const templatesPath = join(process.cwd(), 'plugin', 'skills', 'control-tower', 'references', 'templates.md');
  const templates = extractTemplates(templatesPath);
  assert.ok(templates.registrySkeleton.includes('独占资源租约'));
  assert.ok(templates.bootstrapPrompt.includes('control-tower'));
  assert.ok(templates.handoverTemplate.includes('总控换届快照'));

  let md = templates.registrySkeleton;
  const initParsed = parseRegistry(md);
  assert.equal(initParsed.queue.length, 0, 'Skeleton <T1> placeholder must not parse as a real queue item');
  assert.equal(initParsed.controller.defaultModel, 'Gemini 4 Neon (XHigh)');
  assert.equal(initParsed.lease.lockStatus.includes('`'), false, 'Lease lockStatus must not retain stray backticks');

  const ctrlId = makeConvId('c', '1', '4', '8', 'a');
  const workerId = makeConvId('b', '2', '4', '8', 'd');

  // Section 2: Controller update + history append
  md = updateControllerSection(md, {
    controllerId: ctrlId,
    status: 'ONLINE',
    defaultModel: 'Orchestrator (Neon)',
    appendHistory: true,
    summary: '首任测试总控|带管道符',
  });
  let parsed = parseRegistry(md);
  assert.equal(parsed.controller.currentControllerId, ctrlId);
  assert.equal(parsed.controller.currentControllerStatus, 'ONLINE');
  assert.equal(isActiveController(ctrlId, parsed), true);
  assert.equal(isActiveController(ctrlId.slice(0, 8), parsed), true);
  assert.equal(isActiveController(workerId, parsed), false);
  assert.equal(parsed.controller.handoverHistory.length, 1);
  assert.equal(parsed.controller.handoverHistory[0].summary, '首任测试总控/带管道符');

  // Section 1: Lease lock & release
  md = updateLeaseSection(md, {
    lockStatus: 'LOCKED',
    holder: workerId,
    resource: '测试环境 A',
    since: '2026-11-21',
  });
  parsed = parseRegistry(md);
  assert.equal(parsed.lease.lockStatus, 'LOCKED');
  assert.equal(parsed.lease.holder, workerId);

  // Section 3: Upsert active session
  md = upsertActiveSessionRow(md, {
    conversationId: workerId,
    topic: '协议解析重构',
    modelTool: 'Orchestrator (Neon)',
    lockStatus: '持独占锁',
    status: 'ACTIVE',
    paths: 'plugin/lib/',
  });
  parsed = parseRegistry(md);
  assert.equal(parsed.activeSessions.length, 1);
  assert.equal(parsed.activeSessions[0].conversationId, workerId);
  assert.equal(parsed.activeSessions[0].topic, '协议解析重构');

  // Section 3 -> Section 4: Archive session
  md = archiveActiveSession(md, {
    conversationId: workerId,
    milestone: 'M1 解析收敛',
    summary: '已合入并通过单测',
  });
  parsed = parseRegistry(md);
  assert.equal(parsed.activeSessions.length, 0);
  assert.equal(parsed.archivedSessions.length, 1);
  assert.equal(parsed.archivedSessions[0].conversationId, workerId);
  assert.equal(parsed.archivedSessions[0].milestone, 'M1 解析收敛');

  // Section 5: Queue upsert + rename + delete
  md = upsertQueueRow(md, {
    id: 'T9',
    summary: '测试队列任务',
    status: 'RUNNING',
    route: 'L2 Orchestrator (Neon)',
  });
  md = upsertQueueRow(md, {
    id: 'T10',
    summary: '第二个任务',
    status: 'QUEUED',
    route: 'L1 Gemini 4 Hydrogen (XHigh)',
    requireNew: true,
  });
  assert.throws(
    () => upsertQueueRow(md, { id: 'T9', summary: '重复新增拦截', requireNew: true }),
    (err) => err?.status === 409 && err?.extra?.error === 'duplicate_id'
  );
  assert.throws(
    () => upsertQueueRow(md, { originalId: 'T9', id: 'T10', summary: '重命名吞数据拦截' }),
    (err) => err?.status === 409 && err?.extra?.error === 'duplicate_id'
  );
  parsed = parseRegistry(md);
  assert.ok(parsed.queue.some((q) => q.id === 'T9' && q.status === 'RUNNING'));
  assert.ok(parsed.queue.some((q) => q.id === 'T10'));

  md = deleteQueueRow(md, 'T9');
  md = deleteQueueRow(md, 'T10');
  parsed = parseRegistry(md);
  assert.equal(parsed.queue.some((q) => q.id === 'T9'), false);

  // CRLF templates & non-hex short worker ID prefix non-collision
  const rawCrlf = readFileSync(templatesPath, 'utf8').replace(/\r?\n/g, '\r\n');
  const parsedCrlf = extractTemplatesFromMarkdown(rawCrlf);
  assert.equal(parsedCrlf.registrySkeleton, templates.registrySkeleton);
  assert.ok(parsedCrlf.handoverTemplate.length > 80);

  md = upsertActiveSessionRow(md, {
    conversationId: 'worker-1',
    topic: '子任务 1',
    modelTool: 'Neon',
    lockStatus: '纯离线无锁',
    status: 'ACTIVE',
    paths: '-',
  });
  md = upsertActiveSessionRow(md, {
    conversationId: 'worker-10',
    topic: '子任务 10',
    modelTool: 'Neon',
    lockStatus: '纯离线无锁',
    status: 'ACTIVE',
    paths: '-',
  });
  assert.equal(parseRegistry(md).activeSessions.length, 2);
});
