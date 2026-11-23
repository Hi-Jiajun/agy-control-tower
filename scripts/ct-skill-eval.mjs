#!/usr/bin/env node
/**
 * Control Tower Ring 4 (L4): Skill & Prompt Behavioral Contract Eval Suite
 * Evaluates 10 golden behavioral contracts across SKILL.md, model-routing.md,
 * templates.md, settings.mjs, hooks.json, and live Hook execution.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_GLOBAL_SETTINGS,
  normalizeModelForAgentApi,
  validateDispatchModel,
} from '../plugin/lib/settings.mjs';
import { evaluateFocusGate } from '../plugin/lib/inbox.mjs';
import { buildWorkstreamContractPrompt, evaluateRoadmapGraph } from '../plugin/lib/roadmap.mjs';
import { makeConvId, makeSandbox } from '../tests/helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PLUGIN_DIR = join(REPO_ROOT, 'plugin');
const HOOK_SCRIPT = join(PLUGIN_DIR, 'scripts', 'ct-hook.mjs');

function walkTextFiles(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      walkTextFiles(full, out);
    } else if (ent.isFile()) {
      const buf = readFileSync(full);
      if (!buf.includes(0)) out.push({ path: full, text: buf.toString('utf8') });
    }
  }
  return out;
}

export function runSkillEval() {
  const skillMd = readFileSync(join(PLUGIN_DIR, 'skills', 'control-tower', 'SKILL.md'), 'utf8');
  const routingMd = readFileSync(
    join(PLUGIN_DIR, 'skills', 'control-tower', 'references', 'model-routing.md'),
    'utf8'
  );
  const templatesMd = readFileSync(
    join(PLUGIN_DIR, 'skills', 'control-tower', 'references', 'templates.md'),
    'utf8'
  );
  const hooksJson = JSON.parse(readFileSync(join(PLUGIN_DIR, 'hooks.json'), 'utf8'));
  const pluginFiles = walkTextFiles(PLUGIN_DIR);

  const cases = [
    {
      id: 'EVAL-01',
      title: '纯 Gemini 4 + Orchestrator 路由红线与配额查验边界',
      run() {
        assert.ok(routingMd.includes('Argon') && routingMd.includes('禁用'));
        assert.ok(routingMd.includes('3.8'));
        assert.ok(routingMd.includes('magpie-quota'));
        assert.equal(validateDispatchModel('Gemini 4 Argon (High)').ok, false);
        assert.equal(validateDispatchModel('Orchestrator (Argon)').ok, false);
        assert.equal(validateDispatchModel('Gemini 3.8 Flash (High)').ok, false);
        assert.equal(validateDispatchModel('flash').ok, false);
        assert.equal(validateDispatchModel('Gemini 4 Neon (High)').ok, true);
        assert.equal(validateDispatchModel('Orchestrator (Carbon)').ok, true);
      },
    },
    {
      id: 'EVAL-02',
      title: '新版 Orchestrator 双层自定义（规划+执行模型与思考档位）完整覆盖',
      run() {
        assert.ok(routingMd.includes('规划模型') && routingMd.includes('执行模型'));
        assert.ok(routingMd.includes('Extra High'));
        assert.equal(validateDispatchModel('Orchestrator (Neon Extra High)').ok, true);
        assert.equal(normalizeModelForAgentApi('Orchestrator (Neon Extra High)'), 'gemini-pro-orchestrator-neon');
        assert.equal(normalizeModelForAgentApi('Orchestrator (Carbon High)'), 'gemini-pro-orchestrator');
        assert.equal(normalizeModelForAgentApi('Gemini 4 Hydrogen Extra High'), 'gemini-4-hydrogen-xhigh');
      },
    },
    {
      id: 'EVAL-03',
      title: '缓存保护护栏与 edit_file 精确读行 2 次止损纪律',
      run() {
        assert.ok(routingMd.includes('上下文缓存保护'));
        assert.ok(routingMd.includes('中途随意切换模型'));
        assert.ok(templatesMd.includes('target content not found'));
        assert.ok(templatesMd.includes('read_file') && templatesMd.includes('edit_file'));
        assert.ok(skillMd.includes('edit_file'));
        assert.equal(DEFAULT_GLOBAL_SETTINGS.l0ControllerModel, 'Gemini 4 Neon (High)');
      },
    },
    {
      id: 'EVAL-04',
      title: '100% Antigravity 原生系统通知边界（严禁外部 notify-send）',
      run() {
        assert.ok(skillMd.includes('严禁调用 `notify-send`') || skillMd.includes('严禁使用外部桌面通知'));
        assert.ok(skillMd.includes('ask_question'));
        for (const f of pluginFiles) {
          if (f.path.endsWith('SKILL.md')) continue;
          assert.equal(f.text.includes('notify-send'), false, `Unexpected notify-send in ${f.path}`);
        }
      },
    },
    {
      id: 'EVAL-05',
      title: '总控抗污染红线与 PreToolUse 台账写保护实测拦截',
      run() {
        assert.ok(skillMd.includes('抗污染三条红线'));
        assert.ok(skillMd.includes('不亲自啃大源码与大日志'));
        const sb = makeSandbox('ct-eval-05-');
        try {
          const ws = join(sb.dir, 'ws');
          const dataDir = join(sb.dir, 'data');
          mkdirSync(join(ws, '.agents'), { recursive: true });
          const ctrlId = makeConvId('c', '1', '4', '8', 'a');
          const workerId = makeConvId('a', '2', '4', '8', 'b');
          const regPath = join(ws, '.agents', 'SESSION-REGISTRY.md');
          writeFileSync(
            regPath,
            `# 台账\n## 二、常驻主交流总控会话\n- **当前现役总控会话**：\`${ctrlId}\`（状态：\`ONLINE\`）\n`,
            'utf8'
          );
          const out = JSON.parse(
            execFileSync(process.execPath, [HOOK_SCRIPT, 'PreToolUse'], {
              input: JSON.stringify({
                conversationId: workerId,
                workspacePaths: [ws],
                cwd: ws,
                toolCall: { name: 'edit_file', args: { Path: regPath } },
              }),
              encoding: 'utf8',
              env: { ...process.env, AGY_CONTROL_TOWER_DATA_DIR: dataDir },
            })
          );
          assert.equal(out.decision, 'ask');
        } finally {
          sb.cleanup();
        }
      },
    },
    {
      id: 'EVAL-06',
      title: '双角色 SessionStart 行为契约（总控/已入账专职/无关会话）',
      run() {
        const sb = makeSandbox('ct-eval-06-');
        try {
          const ws = join(sb.dir, 'ws');
          const dataDir = join(sb.dir, 'data');
          mkdirSync(join(ws, '.agents'), { recursive: true });
          const ctrlId = makeConvId('c', '1', '4', '8', 'a');
          const workerId = makeConvId('a', '2', '4', '8', 'b');
          const otherId = makeConvId('e', '3', '4', '8', 'f');
          writeFileSync(
            join(ws, '.agents', 'SESSION-REGISTRY.md'),
            `# 台账\n## 一、当前独占资源租约\n| 字段 | 当前值 |\n| --- | --- |\n| **锁状态** | \`IDLE\` |\n## 二、常驻主交流总控会话\n- **当前现役总控会话**：\`${ctrlId}\`（状态：\`ONLINE\`）\n## 三、活跃 / 挂起专职会话台账\n| 会话链接与 ID | 任务编号 / 主题 | 模型与工具 | 资源锁状态 | 当前状态 | 工作目录与日志回查路径 |\n| --- | --- | --- | --- | --- | --- |\n| [\`${workerId.slice(0, 8)}\`](conversation://${workerId}) | 评测任务 | Neon | 纯离线无锁 | \`ACTIVE\` | - |\n`,
            'utf8'
          );
          const runStart = (id) =>
            JSON.parse(
              execFileSync(process.execPath, [HOOK_SCRIPT, 'SessionStart'], {
                input: JSON.stringify({ conversationId: id, workspacePaths: [ws] }),
                encoding: 'utf8',
                env: { ...process.env, AGY_CONTROL_TOWER_DATA_DIR: dataDir },
              })
            );
          const ctrlOut = runStart(ctrlId);
          assert.ok(ctrlOut.injectSteps?.[0]?.systemMessage?.systemMessage?.includes('[control-tower 总控就位]'));
          const workerOut = runStart(workerId);
          assert.ok(workerOut.injectSteps?.[0]?.systemMessage?.systemMessage?.includes('[control-tower 专职会话约束]'));
          const otherOut = runStart(otherId);
          assert.deepEqual(otherOut, {});
        } finally {
          sb.cleanup();
        }
      },
    },
    {
      id: 'EVAL-07',
      title: '三层隔离配置与 PLUGIN_DATA 托管模式规范完整',
      run() {
        assert.ok(skillMd.includes('@plugin_data/SESSION-REGISTRY.md'));
        assert.ok(skillMd.includes('plugin_data/control-tower'));
        assert.ok(routingMd.includes('设置中心'));
      },
    },
    {
      id: 'EVAL-08',
      title: '纯净 ./plugin/ 边界与零全局规则约束 (components.rules === 0)',
      run() {
        assert.equal(existsSync(join(PLUGIN_DIR, 'rules')), false, 'plugin/rules must not exist');
        assert.equal(existsSync(join(PLUGIN_DIR, 'AGENTS.md')), false, 'plugin/AGENTS.md must not exist');
        const entries = Object.values(hooksJson || {});
        assert.equal(entries.length, 4, 'hooks.json must register exact 4 named hook entries');
        assert.ok(entries.some((e) => Array.isArray(e?.SessionStart)));
        assert.ok(entries.some((e) => Array.isArray(e?.PreInvocation)));
        assert.ok(entries.some((e) => Array.isArray(e?.PreToolUse) && Array.isArray(e.PreToolUse[0]?.hooks)));
        assert.ok(entries.some((e) => Array.isArray(e?.Stop)));
      },
    },
    {
      id: 'EVAL-09',
      title: '模板可移植性与全插件零间隔号字符门禁',
      run() {
        assert.equal(templatesMd.includes('.gemini/config'), false);
        assert.equal(templatesMd.includes('skills/control-tower'), false);
        const dot = String.fromCharCode(0x00b7);
        for (const f of pluginFiles) {
          assert.equal(f.text.includes(dot), false, `Middle dot found in ${f.path}`);
        }
      },
    },
    {
      id: 'EVAL-10',
      title: '弹性非强制换届策略与账号无 Carbon 平滑降档阶梯',
      run() {
        assert.ok(skillMd.includes('5 次') && skillMd.includes('非强制'));
        assert.ok(skillMd.includes('本会话忽略'));
        assert.ok(routingMd.includes('临时替补') && routingMd.includes('Neon (XHigh)'));
        assert.equal(DEFAULT_GLOBAL_SETTINGS.controllerCompactionThreshold, 5);
      },
    },
    {
      id: 'EVAL-11',
      title: '方向一：隐藏执行面优先与顶层会话白名单瘦身契约',
      run() {
        assert.ok(skillMd.includes('隐藏面优先') && skillMd.includes('白名单'));
        assert.ok(skillMd.includes('invoke_subagent') && skillMd.includes('run_workflow'));
        assert.equal(DEFAULT_GLOBAL_SETTINGS.dispatchSurfacePolicy, 'hidden_first');
      },
    },
    {
      id: 'EVAL-12',
      title: '方向二：冷热解耦零 Token 哨兵、焦点防打扰门禁与按需域分总控',
      run() {
        assert.ok(skillMd.includes('零 Token') && skillMd.includes('Focus Gate'));
        assert.ok(skillMd.includes('域分总控') && templatesMd.includes('域分总控'));
        const now = 1_700_000_000_000;
        const gateBusy = evaluateFocusGate(
          { inFlight: false, lastUserInputAt: now, lastTurnEndAt: now },
          { nowMs: now + 30_000, focusCooldownSec: 180 }
        );
        assert.equal(gateBusy.isForegroundBusy, true);
        assert.equal(gateBusy.shouldInterruptFor('P2'), false);
      },
    },
    {
      id: 'EVAL-13',
      title: '方向三：子会话四象限物理隔离、协作拓扑与文件所有权契约',
      run() {
        assert.ok(skillMd.includes('workspace: "share"') && skillMd.includes('workspace: "branch"'));
        assert.ok(skillMd.includes('Ownership Map') && templatesMd.includes('接力契约'));
        const contract = buildWorkstreamContractPrompt({
          id: 'W1',
          title: '模块实现',
          isolation: 'share',
          collaboration: 'swarm_channel',
          ownership: ['src/core/'],
          acceptance: 'npm test',
        });
        assert.ok(contract.includes('workspace: "share"') && contract.includes('src/core/'));
      },
    },
    {
      id: 'EVAL-14',
      title: '方向四：三层混合存储长期路线图 DAG 与所有权冲突预警',
      run() {
        assert.ok(skillMd.includes('ROADMAP.md') && skillMd.includes('roadmap.json'));
        assert.ok(skillMd.includes('Rolling Wave'));
        const g = evaluateRoadmapGraph({
          milestones: [{ id: 'M1', title: 'M1', status: 'active' }],
          nodes: [
            { id: 'A', title: 'A', status: 'active', ownership: ['lib/'] },
            { id: 'B', title: 'B', status: 'planned', dependsOn: ['A'], ownership: ['tests/'] },
            { id: 'C', title: 'C', status: 'planned', dependsOn: [], ownership: ['lib/a.mjs'] },
          ],
        });
        assert.equal(g.hasCycle, false);
        assert.deepEqual(g.readyIds, ['C']);
        assert.equal(g.overlaps.length, 1);
      },
    },
  ];

  const results = [];
  for (const c of cases) {
    try {
      c.run();
      results.push({ id: c.id, title: c.title, ok: true });
    } catch (err) {
      results.push({ id: c.id, title: c.title, ok: false, error: err?.message || String(err) });
    }
  }
  return {
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const jsonMode = process.argv.includes('--json');
  const summary = runSkillEval();
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    for (const r of summary.results) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'} [${r.id}] ${r.title}${r.error ? ` -> ${r.error}` : ''}`);
    }
    console.log(`----\nSkill Evals: ${summary.passed}/${summary.total} passed`);
  }
  process.exit(summary.failed > 0 ? 1 : 0);
}
