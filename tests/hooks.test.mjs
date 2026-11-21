import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
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

test('Hooks stay silent for non-controllers and support single/multi ID intake + deduped anti-aging', () => {
  const sb = makeSandbox();
  try {
    const ws = join(sb.dir, 'ws');
    mkdirSync(join(ws, '.agents'), { recursive: true });
    const appDir = join(sb.dir, 'app_data');
    const dataDir = join(sb.dir, 'plugin_data');

    const ctrlId = makeConvId('c', '1', '4', '8', 'a');
    const workerA = makeConvId('a', '2', '4', '8', 'b');
    const workerB = makeConvId('b', '3', '4', '8', 'c');
    const otherId = makeConvId('e', '4', '4', '8', 'f');

    const regText = `# 台账
## 一、当前独占资源租约
| 字段 | 当前值 |
| --- | --- |
| **锁状态** | \`IDLE（空闲待分配）\` |
| **持锁会话** | - |

## 二、常驻主交流总控会话
- **当前现役总控会话**：\`${ctrlId}\`（状态：\`ONLINE\`）
`;
    writeFileSync(join(ws, '.agents', 'SESSION-REGISTRY.md'), regText, 'utf8');

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
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\n任务B待接锁\n</USER_REQUEST>' }),
        JSON.stringify({ step_index: 4, type: 'PLANNER_RESPONSE', model: 'gemini-4-carbon-medium', status: 'DONE' }),
      ].join('\n') + '\n',
      'utf8'
    );

    const cLog = makeTranscriptPath(appDir, ctrlId);
    writeFileSync(
      cLog,
      [
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon', input_tokens: 120000, cache_read_tokens: 0 }),
        JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon', input_tokens: 20000, cache_read_tokens: 0 }),
        JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon', input_tokens: 110000, cache_read_tokens: 0 }),
        JSON.stringify({ step_index: 4, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon', input_tokens: 18000, cache_read_tokens: 0 }),
      ].join('\n') + '\n',
      'utf8'
    );

    const env = {
      AGY_CONTROL_TOWER_DATA_DIR: dataDir,
      ANTIGRAVITY_APP_DATA_DIR: appDir,
    };

    // 1) Non-controller must stay silent and NOT create plugin_data directory
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

    // 2) Active controller SessionStart brief
    const ss = callHook('SessionStart', { conversationId: ctrlId, workspacePaths: [ws] }, env);
    const ssMsg = ss.injectSteps[0].systemMessage.systemMessage;
    assert.ok(ssMsg.includes('[control-tower 总控就位]') && ssMsg.includes('IDLE'));

    // 3) Short-command multi-ID lookup + first compaction alert
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
    assert.ok(msgs1.some((m) => m.includes('[control-tower 裸ID速查]') && m.includes('任务B待接锁')));
    assert.ok(msgs1.some((m) => m.includes('[control-tower 换届提醒]') && m.includes('2 次')));

    // 4) Repeated turn with normal text (or non-brain git sha) dedupes handover warning and stays silent
    const p2 = callHook(
      'PreInvocation',
      {
        conversationId: ctrlId,
        workspacePaths: [ws],
        lastUserInput: '查看 commit deadbeef 是否合并，以及代码里的 `abcdef12`',
        transcriptPath: cLog,
      },
      env
    );
    assert.deepEqual(p2, {});
  } finally {
    sb.cleanup();
  }
});
