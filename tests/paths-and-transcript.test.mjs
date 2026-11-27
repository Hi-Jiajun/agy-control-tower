import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  findExistingRegistry,
  MANAGED_REGISTRY_VIRTUAL_REL,
  PathError,
  resolveAppDataDirs,
  resolvePluginDataDir,
  resolveRegistryTarget,
} from '../plugin/lib/paths.mjs';
import {
  extractPromptSessionIds,
  hasOutboundAgentApiReport,
  inspectNativeSwarm,
  inspectTranscript,
  loadPluginState,
  resolveBrainTranscript,
  savePluginState,
} from '../plugin/lib/transcript.mjs';
import { makeConvId, makeSandbox, makeTranscriptPath } from './helpers.mjs';

test('resolveAppDataDirs & resolvePluginDataDir prioritize overrides and multi-host dirs without side-effects', () => {
  const sb = makeSandbox();
  try {
    const fakeHome = join(sb.dir, 'home');
    const ideBrain = join(fakeHome, '.gemini', 'antigravity-ide', 'brain');
    const cliBrain = join(fakeHome, '.gemini', 'antigravity-cli', 'brain');
    mkdirSync(ideBrain, { recursive: true });
    mkdirSync(cliBrain, { recursive: true });

    const dirs = resolveAppDataDirs({ env: { HOME: fakeHome } });
    assert.equal(dirs[0], join(fakeHome, '.gemini', 'antigravity-ide'));
    assert.ok(dirs.includes(join(fakeHome, '.gemini', 'antigravity-cli')));

    const hinted = join(cliBrain, makeConvId('b', '2'), '.system_generated', 'logs', 'transcript.jsonl');
    const hintedDirs = resolveAppDataDirs({ env: { HOME: fakeHome }, hintPath: hinted });
    assert.equal(hintedDirs[0], join(fakeHome, '.gemini', 'antigravity-cli'));

    const pData = resolvePluginDataDir({ env: { HOME: fakeHome } });
    assert.equal(pData, join(fakeHome, '.gemini', 'antigravity-ide', 'plugin_data', 'control-tower'));

    const pDataOtherPlugin = resolvePluginDataDir({
      env: { HOME: fakeHome, PLUGIN_DATA: join(sb.dir, 'plugin_data', 'other-plugin') },
    });
    assert.equal(pDataOtherPlugin, join(fakeHome, '.gemini', 'antigravity-ide', 'plugin_data', 'control-tower'));

    const pDataOwned = resolvePluginDataDir({
      env: { HOME: fakeHome, PLUGIN_DATA: join(sb.dir, 'plugin_data', 'control-tower') },
    });
    assert.equal(pDataOwned, join(sb.dir, 'plugin_data', 'control-tower'));

    const pDataExplicit = resolvePluginDataDir({
      env: {
        HOME: fakeHome,
        PLUGIN_DATA: join(sb.dir, 'plugin_data', 'other-plugin'),
        AGY_CONTROL_TOWER_DATA_DIR: join(sb.dir, 'custom-data'),
      },
    });
    assert.equal(pDataExplicit, join(sb.dir, 'custom-data'));
  } finally {
    sb.cleanup();
  }
});

test('resolveRegistryTarget blocks traversal and escaping symlinks', () => {
  const sb = makeSandbox();
  try {
    const ws = join(sb.dir, 'ws');
    const outside = join(sb.dir, 'outside');
    mkdirSync(ws, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const secretFile = join(outside, 'secret.md');
    writeFileSync(secretFile, 'top-secret', 'utf8');

    assert.throws(() => resolveRegistryTarget(ws, '../outside/secret.md', { allowMissing: true }), PathError);

    symlinkSync(secretFile, join(ws, 'SESSION-REGISTRY.md'));
    assert.throws(() => resolveRegistryTarget(ws, 'SESSION-REGISTRY.md'), PathError);
    assert.throws(() => findExistingRegistry(ws), PathError);
  } finally {
    sb.cleanup();
  }
});

test('extractPromptSessionIds extracts bare and multi-ID prompts while ignoring code blocks and words', () => {
  const id1 = makeConvId('a', '1', '4', '8', 'b');
  const id2 = makeConvId('c', '2', '4', '9', 'd');

  const rSingle = extractPromptSessionIds(id1);
  assert.equal(rSingle.isSingleBareId, true);
  assert.deepEqual(rSingle.ids, [id1]);

  const rMulti = extractPromptSessionIds(`${id1.slice(0, 8)} 已做完，看看状态并把锁转给 ${id2}`);
  assert.equal(rMulti.isSingleBareId, false);
  assert.deepEqual(rMulti.ids, [id1.slice(0, 8), id2]);

  const rCode = extractPromptSessionIds(
    `请忽略代码块里的 \`\`\`\n${id1}\n\`\`\` 和行内 \`${id2}\` 以及普通单词 Orchestrator`
  );
  assert.deepEqual(rCode.ids, []);
});

test('inspectTranscript reads head/tail on large files, incrementally caches compactions, and enforces LRU', () => {
  const sb = makeSandbox();
  try {
    const appDir = join(sb.dir, 'app');
    const convId = makeConvId('d', '4', '4', '8', 'e');
    const tp = makeTranscriptPath(appDir, convId);

    const lines = [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        content: '<USER_REQUEST>\n实现分段增量扫描\n</USER_REQUEST>',
      }),
    ];
    // Generate > 256KB payload with 2 token-drop compactions
    const filler = 'x'.repeat(1800);
    for (let i = 1; i <= 160; i += 1) {
      let inTok = 50000 + i * 500;
      if (i === 60) inTok = 12000; // compaction 1
      if (i === 120) inTok = 15000; // compaction 2
      lines.push(
        JSON.stringify({
          step_index: i,
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-neon-high',
          input_tokens: inTok,
          cache_read_tokens: 0,
          created_at: `2026-11-21T21:00:${String(i % 60).padStart(2, '0')}+08:00`,
          status: 'DONE',
          note: filler,
        })
      );
    }
    writeFileSync(tp, `${lines.join('\n')}\n`, 'utf8');

    const res1 = inspectTranscript(tp);
    assert.equal(res1.info.exists, true);
    assert.equal(res1.info.goal, '实现分段增量扫描');
    assert.equal(res1.info.maxStepIndex, 160);
    assert.equal(res1.info.lineCount, 161);
    assert.equal(res1.info.compactions, 2);
    assert.equal(res1.info.lastModel, 'gemini-4-neon-high');

    // Cache hit with no file changes
    const res2 = inspectTranscript(tp, { cacheEntry: res1.nextCacheEntry });
    assert.equal(res2.info.compactions, 2);
    assert.equal(res2.nextCacheEntry, res1.nextCacheEntry);

    // Append compaction 3 and verify incremental resume updates count
    appendFileSync(
      tp,
      `${JSON.stringify({
        step_index: 161,
        type: 'CHECKPOINT',
        model: 'gemini-4-carbon-high',
        status: 'DONE',
      })}\n`,
      'utf8'
    );
    const res3 = inspectTranscript(tp, { cacheEntry: res2.nextCacheEntry });
    assert.equal(res3.info.maxStepIndex, 161);
    assert.equal(res3.info.lineCount, 162);
    assert.equal(res3.info.lastModel, 'gemini-4-carbon-high');
    assert.equal(res3.info.compactions, 3);

    // Append >64KB tail line with multi-byte UTF-8 and verify telemetry does not blank out
    appendFileSync(
      tp,
      `${JSON.stringify({
        step_index: 162,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-carbon-high',
        status: 'RUNNING',
        created_at: '2026-11-24T01:00:00Z',
        content: '中文超长输出'.repeat(14000),
      })}\n`,
      'utf8'
    );
    const resBigTail = inspectTranscript(tp, { cacheEntry: res3.nextCacheEntry });
    assert.equal(resBigTail.info.maxStepIndex, 162);
    assert.equal(resBigTail.info.lastModel, 'gemini-4-carbon-high');
    assert.equal(resBigTail.info.lastStatus, 'RUNNING');
    assert.equal(resBigTail.info.lastUpdatedAt, '2026-11-24T01:00:00Z');

    // Dual-model Orchestrator dedup: CHECKPOINT + delayed second-model drop must count as 1 compaction, not 2
    const convDual = makeConvId('e', '5', '4', '8', 'f');
    const dualTp = makeTranscriptPath(appDir, convDual);
    const dualRows = [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\n双层编排器防双计校验\n</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-xhigh', input_tokens: 180000, cache_read_tokens: 0 },
      { step_index: 2, type: 'PLANNER_RESPONSE', model: 'gemini-4-hydrogen-xhigh', input_tokens: 180000, cache_read_tokens: 0 },
      { step_index: 3, type: 'CHECKPOINT', status: 'DONE' },
      { step_index: 4, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-xhigh', input_tokens: 30000, cache_read_tokens: 0 },
      { step_index: 5, type: 'GENERIC', status: 'DONE' },
      { step_index: 6, type: 'GENERIC', status: 'DONE' },
      { step_index: 7, type: 'GENERIC', status: 'DONE' },
      { step_index: 8, type: 'PLANNER_RESPONSE', model: 'gemini-4-hydrogen-xhigh', input_tokens: 35000, cache_read_tokens: 0 },
      { step_index: 9, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-xhigh', input_tokens: 180000, cache_read_tokens: 0 },
      { step_index: 10, type: 'PLANNER_RESPONSE', model: 'gemini-4-hydrogen-xhigh', input_tokens: 180000, cache_read_tokens: 0 },
      { step_index: 11, type: 'CHECKPOINT', status: 'DONE' },
      { step_index: 12, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-xhigh', input_tokens: 30000, cache_read_tokens: 0 },
      { step_index: 13, type: 'GENERIC', status: 'DONE' },
      { step_index: 14, type: 'GENERIC', status: 'DONE' },
      { step_index: 15, type: 'GENERIC', status: 'DONE' },
      { step_index: 16, type: 'PLANNER_RESPONSE', model: 'gemini-4-hydrogen-xhigh', input_tokens: 35000, cache_read_tokens: 0 },
    ];
    writeFileSync(dualTp, `${dualRows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    const resDual = inspectTranscript(dualTp);
    assert.equal(resDual.info.goal, '双层编排器防双计校验');
    assert.equal(resDual.info.compactions, 2);
    assert.equal(resDual.nextCacheEntry.accVersion, 2);

    // Stale v1 cache (missing accVersion) recomputes cleanly back down to true count
    const staleCache = {
      ...resDual.nextCacheEntry,
      accVersion: undefined,
      info: { ...resDual.info, compactions: 9 },
      acc: { ...resDual.nextCacheEntry.acc, compactions: 9 },
    };
    const resRecomputed = inspectTranscript(dualTp, { cacheEntry: staleCache });
    assert.equal(resRecomputed.info.compactions, 2);
    assert.equal(resRecomputed.nextCacheEntry.accVersion, 2);

    // 512B head-hash incremental resume preserves goal without re-parsing head
    appendFileSync(dualTp, `${JSON.stringify({ step_index: 17, type: 'GENERIC', status: 'DONE' })}\n`, 'utf8');
    const resDualInc = inspectTranscript(dualTp, { cacheEntry: resDual.nextCacheEntry });
    assert.equal(resDualInc.info.goal, '双层编排器防双计校验');
    assert.equal(resDualInc.info.compactions, 2);

    // Verify prefix resolution
    const resolved = resolveBrainTranscript(convId.slice(0, 8), {
      env: { ANTIGRAVITY_APP_DATA_DIR: appDir },
    });
    assert.equal(resolved.status, 'ok');
    assert.equal(resolved.conversationId, convId);

    // Verify LRU pruning to 200 items
    const dataDir = join(sb.dir, 'pdata');
    const bigCache = {};
    for (let i = 0; i < 230; i += 1) {
      bigCache[`/tmp/p-${i}`] = { updatedAt: i };
    }
    savePluginState(dataDir, { controllers: {}, transcriptCache: bigCache });
    const loaded = loadPluginState(dataDir);
    assert.equal(Object.keys(loaded.transcriptCache).length, 200);
    assert.equal('/tmp/p-229' in loaded.transcriptCache, true);
    assert.equal('/tmp/p-0' in loaded.transcriptCache, false);
  } finally {
    sb.cleanup();
  }
});

test('Managed plugin_data registry, long-report ID filtering, outbound report detection, and native swarm inspection work', () => {
  const sb = makeSandbox();
  try {
    const ws = join(sb.dir, 'ws');
    const dataDir = join(sb.dir, 'pdata');
    const appDir = join(sb.dir, 'app');
    mkdirSync(ws, { recursive: true });

    // Managed registry target
    const managedTarget = resolveRegistryTarget(ws, MANAGED_REGISTRY_VIRTUAL_REL, {
      allowMissing: true,
      dataDir,
    });
    mkdirSync(join(managedTarget, '..'), { recursive: true });
    writeFileSync(managedTarget, '# 台账\n', 'utf8');
    const foundManaged = findExistingRegistry(ws, {
      dataDir,
      workspaceSettings: { registryMode: 'plugin_data' },
    });
    assert.equal(foundManaged?.isManaged, true);
    assert.equal(foundManaged?.relPath, MANAGED_REGISTRY_VIRTUAL_REL);

    // Custom relative path traversal rejection
    assert.throws(
      () => resolveRegistryTarget(ws, '../escape.md', { allowMissing: true, allowCustomRel: true }),
      PathError
    );
    assert.throws(
      () => resolveRegistryTarget(ws, 'notes/not-md.txt', { allowMissing: true, allowCustomRel: true }),
      PathError
    );

    // Long prompt filtering skips incidental 8-char commit sha while keeping full UUID and knownIds
    const idFull = makeConvId('a', '7', '4', '9', 'c');
    const idKnown = makeConvId('b', '8', '4', '1', 'd');
    const padding = '长汇报正文'.repeat(120);
    const longPrompt = `${padding} commit deadbeef 已提交，会话 ${idFull} 与已知前缀 ${idKnown.slice(0, 8)} 完成核查`;
    const rLong = extractPromptSessionIds(longPrompt, { knownIds: [idKnown] });
    assert.deepEqual(rLong.ids, [idFull, idKnown.slice(0, 8)]);

    // Outbound agentapi report detection + native swarm inspection
    const ctrlId = makeConvId('c', '1', '4', '8', 'a');
    const workerId = makeConvId('d', '2', '4', '8', 'b');
    const wLog = makeTranscriptPath(appDir, workerId);
    writeFileSync(
      wLog,
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nSwarm子任务\n</USER_REQUEST>' }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-neon-high',
          status: 'DONE',
          tool_calls: [{ name: 'run_command', args: { CommandLine: `agentapi send-message ${ctrlId} "[CT_REPORT:DONE] ok"` } }],
        }),
      ].join('\n') + '\n',
      'utf8'
    );
    assert.equal(hasOutboundAgentApiReport(wLog, ctrlId), true);
    assert.equal(hasOutboundAgentApiReport(wLog, makeConvId('9', '9', '9', '9', '9')), false);

    const swarmDir = join(appDir, 'brain', ctrlId, '.system_generated', 'swarm');
    mkdirSync(swarmDir, { recursive: true });
    writeFileSync(
      join(swarmDir, 'members.json'),
      JSON.stringify({
        title: '重构集群',
        members: {
          parser: { conversation_id: workerId, model: 'gemini-4-neon-high', role: 'worker' },
          narrator: { conversation_id: '', role: 'narrator', killed: false },
        },
      }),
      'utf8'
    );
    writeFileSync(
      join(swarmDir, 'board.jsonl'),
      `${JSON.stringify({ seq: 1, agent: 'coordinator', text: '@parser 开始', time: '2026-11-22T00:00:00Z' })}\n`,
      'utf8'
    );
    const swarmInfo = inspectNativeSwarm(ctrlId, { env: { ANTIGRAVITY_APP_DATA_DIR: appDir } });
    assert.equal(swarmInfo.active, true);
    assert.equal(swarmInfo.title, '重构集群');
    assert.equal(swarmInfo.members.length, 2);
    assert.equal(swarmInfo.members[0].steps, 1);
    assert.equal(swarmInfo.recentPosts.length, 1);
  } finally {
    sb.cleanup();
  }
});
