import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  findExistingRegistry,
  PathError,
  resolveAppDataDirs,
  resolvePluginDataDir,
  resolveRegistryTarget,
} from '../plugin/lib/paths.mjs';
import {
  extractPromptSessionIds,
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

    const pDataExplicit = resolvePluginDataDir({
      env: { HOME: fakeHome, AGY_CONTROL_TOWER_DATA_DIR: join(sb.dir, 'custom-data') },
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
