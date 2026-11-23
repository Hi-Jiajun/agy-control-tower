import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { saveGlobalSettings, savePluginSettings } from '../plugin/lib/settings.mjs';
import { loadWorkspaceInbox, recordControllerFocus } from '../plugin/lib/inbox.mjs';
import { loadPluginState, savePluginState } from '../plugin/lib/transcript.mjs';
import { makeConvId, makeSandbox, makeTranscriptPath } from './helpers.mjs';

const HOOK_SCRIPT = join(process.cwd(), 'plugin', 'scripts', 'ct-hook.mjs');

function callHook(eventName, payload, env) {
  const out = execFileSync(process.execPath, [HOOK_SCRIPT, eventName], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return JSON.parse(out);
}

function makeCompactedLog(count) {
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(
      JSON.stringify({
        step_index: i * 2 + 1,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-pro-orchestrator-neon',
        input_tokens: 120000,
        cache_read_tokens: 0,
      })
    );
    lines.push(
      JSON.stringify({
        step_index: i * 2 + 2,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-pro-orchestrator-neon',
        input_tokens: 20000,
        cache_read_tokens: 0,
      })
    );
  }
  return lines.join('\n') + '\n';
}

test('Hooks support dual-role SessionStart, PreToolUse registry guard, configurable 5-compaction handover + ignore, and Stop receipt batching', () => {
  const sb = makeSandbox();
  try {
    const ws = join(sb.dir, 'ws');
    const regDir = join(ws, '.agents');
    mkdirSync(regDir, { recursive: true });
    const appDir = join(sb.dir, 'app_data');
    const dataDir = join(sb.dir, 'plugin_data');
    const cfgDir = join(sb.dir, 'cfg');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, 'config.json'),
      JSON.stringify({ userSettings: { permissionPreset: 'AGENT_PERMISSION_PRESET_AUTO' } }),
      'utf8'
    );

    const ctrlId = makeConvId('c', '1', '4', '8', 'a');
    const workerA = makeConvId('a', '2', '4', '8', 'b');
    const workerB = makeConvId('b', '3', '4', '8', 'c');
    const otherId = makeConvId('e', '4', '4', '8', 'f');

    const regPath = join(regDir, 'SESSION-REGISTRY.md');
    const regText = `# 台账
## 一、当前独占资源租约
| 字段 | 当前值 |
| --- | --- |
| **锁状态** | \`IDLE（空闲待分配）\` |
| **持锁会话** | - |

## 二、常驻主交流总控会话
- **当前现役总控会话**：\`${ctrlId}\`（状态：\`ONLINE\`）

## 三、活跃 / 挂起专职会话台账
| 会话链接与 ID | 任务编号 / 主题 | 模型与工具 | 资源锁状态 | 当前状态 | 工作目录与日志回查路径 |
| --- | --- | --- | --- | --- | --- |
| [\`${workerA.slice(0, 8)}\`](conversation://${workerA}) | 任务A | Orchestrator (Neon) | 纯离线无锁 | \`ACTIVE\` | - |
| [\`${workerB.slice(0, 8)}\`](conversation://${workerB}) | 任务B | Orchestrator (Neon) | 纯离线无锁 | \`ACTIVE\` | - |
`;
    writeFileSync(regPath, regText, 'utf8');

    const wLogA = makeTranscriptPath(appDir, workerA);
    writeFileSync(
      wLogA,
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\n任务A完成\n</USER_REQUEST>' }),
        JSON.stringify({ step_index: 8, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high', status: 'DONE' }),
      ].join('\n') + '\n',
      'utf8'
    );

    const wLogB = makeTranscriptPath(appDir, workerB);
    writeFileSync(
      wLogB,
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\n任务B收口\n</USER_REQUEST>' }),
        JSON.stringify({ step_index: 6, type: 'PLANNER_RESPONSE', model: 'gemini-4-carbon-medium', status: 'DONE' }),
      ].join('\n') + '\n',
      'utf8'
    );

    const cLog = makeTranscriptPath(appDir, ctrlId);
    writeFileSync(cLog, makeCompactedLog(2), 'utf8');

    // Mock agentapi executable to record Stop hook wake calls
    const mockExe = join(sb.dir, 'mock-agentapi.mjs');
    const mockLog = join(sb.dir, 'agentapi-calls.jsonl');
    writeFileSync(
      mockExe,
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(mockLog)}, JSON.stringify(process.argv.slice(2)) + '\\n', 'utf8');
process.stdout.write(JSON.stringify({ ok: true }));
`,
      'utf8'
    );
    chmodSync(mockExe, 0o755);

    const env = {
      AGY_CONTROL_TOWER_DATA_DIR: dataDir,
      ANTIGRAVITY_APP_DATA_DIR: appDir,
      AGY_CONFIG_DIR: cfgDir,
      ANTIGRAVITY_AGENTAPI_EXE: mockExe,
    };

    // 1) Unenrolled session stays silent and NEVER creates plugin_data
    assert.deepEqual(
      callHook('SessionStart', { conversationId: otherId, workspacePaths: [ws] }, env),
      {}
    );
    assert.deepEqual(
      callHook(
        'PreInvocation',
        {
          conversationId: otherId,
          workspacePaths: [ws],
          lastUserInput: workerA.slice(0, 8),
          transcriptPath: cLog,
        },
        env
      ),
      {}
    );
    assert.equal(existsSync(dataDir), false);

    // 2) Enrolled worker gets SessionStart lock & reporting reminder, still no disk write
    const workerSs = callHook('SessionStart', { conversationId: workerA, workspacePaths: [ws] }, env);
    const workerSsMsg = workerSs.injectSteps[0].systemMessage.systemMessage;
    assert.ok(workerSsMsg.includes('[control-tower 专职会话约束]') && workerSsMsg.includes(ctrlId));
    assert.equal(existsSync(dataDir), false);

    // 3) PreToolUse blocks/asks on non-controller editing registry, allows normal files & controller
    assert.deepEqual(
      callHook(
        'PreToolUse',
        {
          conversationId: workerA,
          workspacePaths: [ws],
          toolCall: { name: 'edit_file', args: { Path: join(ws, 'src', 'index.js') } },
        },
        env
      ),
      { decision: 'allow' }
    );
    const preAsk = callHook(
      'PreToolUse',
      {
        conversationId: workerA,
        workspacePaths: [ws],
        toolCall: { name: 'write_file', args: { Path: regPath } },
      },
      env
    );
    assert.equal(preAsk.decision, 'ask');
    assert.deepEqual(
      callHook(
        'PreToolUse',
        {
          conversationId: ctrlId,
          workspacePaths: [ws],
          toolCall: { name: 'write_file', args: { Path: regPath } },
        },
        env
      ),
      { decision: 'allow' }
    );

    // 4) Active controller SessionStart brief shows 5-compaction default & balanced autonomy (without schema warning)
    const ss = callHook('SessionStart', { conversationId: ctrlId, workspacePaths: [ws] }, env);
    const ssMsg = ss.injectSteps[0].systemMessage.systemMessage;
    assert.ok(ssMsg.includes('[control-tower 总控就位]') && ssMsg.includes('5 次压缩') && ssMsg.includes('balanced'));
    assert.equal(ssMsg.includes('台账格式提示'), false);

    // 5) With 2 compactions (below default 5), multi-ID lookup triggers WITHOUT handover alert
    const p1 = callHook(
      'PreInvocation',
      {
        conversationId: ctrlId,
        workspacePaths: [ws],
        lastUserInput: `${workerA.slice(0, 8)} 已做完，看看状态并把锁转给 ${workerB}`,
        transcriptPath: cLog,
      },
      env
    );
    const msgs1 = p1.injectSteps.map((s) => s.systemMessage.systemMessage);
    assert.ok(msgs1.some((m) => m.includes('[control-tower 裸ID速查]') && m.includes('任务A完成')));
    assert.ok(msgs1.some((m) => m.includes('[control-tower 裸ID速查]') && m.includes('任务B收口')));
    assert.equal(msgs1.some((m) => m.includes('[control-tower 换届提醒]')), false);

    // 6) Reaching 5 compactions triggers handover alert; ignoring suppresses further alerts
    writeFileSync(cLog, makeCompactedLog(5), 'utf8');
    const pHandover = callHook(
      'PreInvocation',
      {
        conversationId: ctrlId,
        workspacePaths: [ws],
        lastUserInput: '继续看下状态',
        transcriptPath: cLog,
      },
      env
    );
    assert.ok(
      pHandover.injectSteps.some((s) => s.systemMessage.systemMessage.includes('[control-tower 换届提醒]') && s.systemMessage.systemMessage.includes('5 次'))
    );

    // Mark handoverIgnored for ctrlId & verify 6th compaction stays quiet
    const stAfterHandover = loadPluginState(dataDir);
    stAfterHandover.controllers[ctrlId].handoverIgnored = true;
    savePluginState(dataDir, stAfterHandover);
    writeFileSync(cLog, makeCompactedLog(6), 'utf8');
    const pIgnored = callHook(
      'PreInvocation',
      {
        conversationId: ctrlId,
        workspacePaths: [ws],
        lastUserInput: '查看 commit deadbeef 是否合并，以及代码里的 `abcdef12`',
        transcriptPath: cLog,
      },
      env
    );
    assert.deepEqual(pIgnored, {});

    // 7) Decision report triggers co-decision guide; CT_AUTO_RECEIPT skips duplicate lookup
    const pDecision = callHook(
      'PreInvocation',
      {
        conversationId: ctrlId,
        workspacePaths: [ws],
        lastUserInput: `[CT_REPORT:DECISION] ${workerA} 接口拆分为两个文件`,
        transcriptPath: cLog,
      },
      env
    );
    assert.ok(
      pDecision.injectSteps.some((s) => s.systemMessage.systemMessage.includes('[control-tower 代决策指引]'))
    );

    const pReceipt = callHook(
      'PreInvocation',
      {
        conversationId: ctrlId,
        workspacePaths: [ws],
        lastUserInput: `[CT_AUTO_RECEIPT] ${workerA} 与 ${workerB} 收口`,
        transcriptPath: cLog,
      },
      env
    );
    const receiptMsgs = pReceipt.injectSteps.map((s) => s.systemMessage.systemMessage);
    assert.ok(receiptMsgs.some((m) => m.includes('[control-tower 阶段收口指引]')));
    assert.equal(receiptMsgs.some((m) => m.includes('[control-tower 裸ID速查]')), false);

    // 8) Focus Gate deferral when controller is foreground-busy, then batched Stop wake when controller is idle
    // First: worker A stops while B is active -> stays silent + recorded as P2 in inbox
    callHook(
      'Stop',
      {
        conversationId: workerA,
        workspacePaths: [ws],
        terminationReason: 'NO_TOOL_CALL',
        fullyIdle: true,
        transcriptPath: wLogA,
      },
      env
    );
    assert.equal(existsSync(mockLog), false);
    const inboxAfterA = loadWorkspaceInbox(dataDir, ws);
    assert.ok(inboxAfterA.items.some((x) => x.convId === workerA && x.priority === 'P2'));

    // Next: worker B stops while controller is STILL inside foreground Focus Gate -> deferred, no interruption!
    callHook(
      'Stop',
      {
        conversationId: workerB,
        workspacePaths: [ws],
        terminationReason: 'NO_TOOL_CALL',
        fullyIdle: true,
        transcriptPath: wLogB,
      },
      env
    );
    assert.equal(existsSync(mockLog), false);
    const inboxAfterB = loadWorkspaceInbox(dataDir, ws);
    assert.ok(inboxAfterB.items.some((x) => x.convId === workerB && x.priority === 'P1'));

    // Simulate controller becoming idle (older than focusCooldownSec) & worker B advances 1 step -> fires batched wake!
    recordControllerFocus(dataDir, ws, {
      controllerId: ctrlId,
      inFlight: false,
      lastUserInputAt: Date.now() - 600 * 1000,
      lastTurnEndAt: Date.now() - 600 * 1000,
    });
    writeFileSync(
      wLogB,
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\n任务B收口\n</USER_REQUEST>' }),
        JSON.stringify({ step_index: 7, type: 'PLANNER_RESPONSE', model: 'gemini-4-carbon-medium', status: 'DONE' }),
      ].join('\n') + '\n',
      'utf8'
    );
    callHook(
      'Stop',
      {
        conversationId: workerB,
        workspacePaths: [ws],
        terminationReason: 'NO_TOOL_CALL',
        fullyIdle: true,
        transcriptPath: wLogB,
      },
      env
    );
    assert.equal(existsSync(mockLog), true);
    const callLines = readFileSync(mockLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(callLines.length, 1);
    assert.equal(callLines[0][1], 'send-message');
    assert.equal(callLines[0][4], ctrlId);
    assert.ok(callLines[0][5].includes('[CT_AUTO_RECEIPT]'));
    assert.ok(callLines[0][5].includes(workerA.slice(0, 8)) && callLines[0][5].includes(workerB.slice(0, 8)));

    // 9) Settings override: PreToolUse deny mode + threshold lowered to 2 on a fresh controller
    savePluginSettings(dataDir, { registryWriteGuard: 'deny' });
    saveGlobalSettings(dataDir, { controllerCompactionThreshold: 2 });
    const preDeny = callHook(
      'PreToolUse',
      {
        conversationId: workerA,
        workspacePaths: [ws],
        toolCall: { name: 'edit_file', args: { Path: regPath } },
      },
      env
    );
    assert.equal(preDeny.decision, 'deny');
  } finally {
    sb.cleanup();
  }
});

test('SessionStart emits gentle schema alignment hint when registry deviates from standard template', () => {
  const sb = makeSandbox();
  try {
    const ws = join(sb.dir, 'ws-nonstd');
    mkdirSync(join(ws, '.agents'), { recursive: true });
    const appDir = join(sb.dir, 'app_data');
    const dataDir = join(sb.dir, 'plugin_data');
    const ctrlId = makeConvId('d', '1', '4', '8', 'a');

    const nonStdReg = `# 台账
## 一、当前真机租约
| 字段 | 当前值 |
| --- | --- |
| **锁状态** | \`IDLE\` |

## 二、常驻主交流总控会话
- **当前现役总控会话**：\`${ctrlId}\`（状态：\`ONLINE\`）

## 三、活跃 / 挂起专职会话台账
| 会话链接与 ID | 任务编号 / 主题 | 模型与工具 | 资源锁状态 | 当前状态 | 工作目录与日志回查路径 |
| --- | --- | --- | --- | --- | --- |
| 暂无活跃 | - | - | - | \`IDLE\` | - |
`;
    writeFileSync(join(ws, '.agents', 'SESSION-REGISTRY.md'), nonStdReg, 'utf8');

    const ss = callHook(
      'SessionStart',
      { conversationId: ctrlId, workspacePaths: [ws] },
      { AGY_CONTROL_TOWER_DATA_DIR: dataDir, ANTIGRAVITY_APP_DATA_DIR: appDir }
    );
    const msg = ss.injectSteps[0].systemMessage.systemMessage;
    assert.ok(msg.includes('台账格式提示'));
    assert.ok(msg.includes('第 1 节未匹配标准独占资源租约结构'));
    assert.ok(msg.includes('第 3 节存在无有效会话 ID 的占位行'));
    assert.equal(existsSync(dataDir), false);
  } finally {
    sb.cleanup();
  }
});

test('PreInvocation emits one-shot plugin version sync notice for existing controllers and stays silent on fresh turn 1', () => {
  const sb = makeSandbox();
  try {
    const ws = join(sb.dir, 'ws-ver');
    mkdirSync(join(ws, '.agents'), { recursive: true });
    const appDir = join(sb.dir, 'app_data');
    const dataDir = join(sb.dir, 'plugin_data');
    const oldCtrlId = makeConvId('f', '1', '4', '8', 'a');
    const freshCtrlId = makeConvId('f', '2', '4', '8', 'b');
    const env = { AGY_CONTROL_TOWER_DATA_DIR: dataDir, ANTIGRAVITY_APP_DATA_DIR: appDir };

    const regPath = join(ws, '.agents', 'SESSION-REGISTRY.md');
    const makeReg = (cid) => `# 台账
## 一、当前独占资源租约
| 字段 | 当前值 |
| --- | --- |
| **锁状态** | \`IDLE\` |

## 二、常驻主交流总控会话
- **当前现役总控会话**：\`${cid}\`（状态：\`ONLINE\`）
`;

    // 1) Existing controller with prior transcript steps gets one-shot upgrade notice, then dedupes
    writeFileSync(regPath, makeReg(oldCtrlId), 'utf8');
    const oldLog = makeTranscriptPath(appDir, oldCtrlId);
    writeFileSync(
      oldLog,
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'start' }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high', status: 'DONE' }),
      ].join('\n') + '\n',
      'utf8'
    );
    const r1 = callHook(
      'PreInvocation',
      { conversationId: oldCtrlId, workspacePaths: [ws], lastUserInput: '继续', transcriptPath: oldLog },
      env
    );
    assert.ok(r1.injectSteps.some((s) => s.systemMessage.systemMessage.includes('[control-tower 版本同步]')));

    const r2 = callHook(
      'PreInvocation',
      { conversationId: oldCtrlId, workspacePaths: [ws], lastUserInput: '继续', transcriptPath: oldLog },
      env
    );
    assert.deepEqual(r2, {});

    // 2) Simulating an older synced version triggers notice again once
    const st = loadPluginState(dataDir);
    st.controllers[oldCtrlId].lastSyncedVersion = '1.2.0';
    savePluginState(dataDir, st);
    const r3 = callHook(
      'PreInvocation',
      { conversationId: oldCtrlId, workspacePaths: [ws], lastUserInput: '继续', transcriptPath: oldLog },
      env
    );
    assert.ok(r3.injectSteps.some((s) => s.systemMessage.systemMessage.includes('[control-tower 版本同步]')));

    // 3) Brand-new controller on invocation 1 with empty/single-line log does NOT get noisy upgrade notice
    writeFileSync(regPath, makeReg(freshCtrlId), 'utf8');
    const freshLog = makeTranscriptPath(appDir, freshCtrlId);
    writeFileSync(freshLog, `${JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'cold start' })}\n`, 'utf8');
    const rFresh = callHook(
      'PreInvocation',
      { conversationId: freshCtrlId, workspacePaths: [ws], invocationNum: 1, lastUserInput: '冷启动', transcriptPath: freshLog },
      env
    );
    assert.deepEqual(rFresh, {});
    assert.ok(loadPluginState(dataDir).controllers[freshCtrlId]?.lastSyncedVersion);
  } finally {
    sb.cleanup();
  }
});
