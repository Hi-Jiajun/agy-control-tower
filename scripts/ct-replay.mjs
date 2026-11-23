#!/usr/bin/env node
/**
 * Control Tower Ring 3: Sanitized Incident Replay Runner & Freezer
 * Executes tests/replays/*.replay.json in isolated temporary sandboxes and can
 * freeze recent flight-log errors into sanitized replay fixture skeletons.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUnifiedAttentionBanner, loadWorkspaceInbox, summarizeInbox } from '../plugin/lib/inbox.mjs';
import { readFlightEvents, sanitizeLogString } from '../plugin/lib/logger.mjs';
import { resolvePluginDataDir } from '../plugin/lib/paths.mjs';
import { evaluateRoadmapGraph } from '../plugin/lib/roadmap.mjs';
import { normalizeModelForAgentApi, validateDispatchModel } from '../plugin/lib/settings.mjs';
import { extractPromptSessionIds, hasOutboundAgentApiReport } from '../plugin/lib/transcript.mjs';
import { makeConvId, makeSandbox, makeTranscriptPath } from '../tests/helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DEFAULT_REPLAY_DIR = join(REPO_ROOT, 'tests', 'replays');
const HOOK_SCRIPT = join(REPO_ROOT, 'plugin', 'scripts', 'ct-hook.mjs');

function expandTokens(val, vars) {
  if (typeof val === 'string') {
    let out = val;
    for (const [k, v] of Object.entries(vars)) {
      out = out.split(`\${${k}}`).join(v);
    }
    return out;
  }
  if (Array.isArray(val)) return val.map((item) => expandTokens(item, vars));
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[expandTokens(k, vars)] = expandTokens(v, vars);
    }
    return out;
  }
  return val;
}

export function loadReplayFixtures(dir = DEFAULT_REPLAY_DIR) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.replay.json'))
    .sort();
  return files.map((file) => {
    const fullPath = join(dir, file);
    const data = JSON.parse(readFileSync(fullPath, 'utf8'));
    return { file, fullPath, ...data };
  });
}

export function runReplayFixture(fixture) {
  const sb = makeSandbox('ct-replay-');
  try {
    const ws = join(sb.dir, 'workspace');
    const appData = join(sb.dir, 'app_data');
    const dataDir = join(sb.dir, 'plugin_data');
    mkdirSync(ws, { recursive: true });
    mkdirSync(appData, { recursive: true });

    const vars = {
      SANDBOX: sb.dir,
      WORKSPACE: ws,
      APP_DATA: appData,
      DATA_DIR: dataDir,
      CTRL_ID: makeConvId('c', '1', '4', '8', 'a'),
      WORKER_A: makeConvId('a', '2', '4', '8', 'b'),
      WORKER_B: makeConvId('b', '3', '4', '8', 'c'),
      OTHER_ID: makeConvId('e', '4', '4', '8', 'f'),
    };

    const spec = expandTokens(fixture, vars);
    const kind = spec.kind;

    if (kind === 'paths_resolve_data_dir') {
      const env = spec.action?.env || {};
      const hintPath = spec.action?.hintPath || '';
      const resolved = resolvePluginDataDir({ env, hintPath });
      if (spec.expect?.equals) {
        assert.equal(resolved, spec.expect.equals);
      }
      if (spec.expect?.notEquals) {
        assert.notEqual(resolved, spec.expect.notEquals);
      }
      if (spec.expect?.endsWith) {
        assert.ok(resolved.endsWith(spec.expect.endsWith), `Expected ${resolved} to end with ${spec.expect.endsWith}`);
      }
      return { id: spec.id, ok: true };
    }

    if (kind === 'transcript_outbound_report') {
      const tp = makeTranscriptPath(appData, vars.WORKER_A);
      const lines = (spec.setup?.transcriptLines || []).map((row) =>
        typeof row === 'string' ? row : JSON.stringify(row)
      );
      writeFileSync(tp, `${lines.join('\n')}\n`, 'utf8');
      for (const check of spec.expect?.checks || []) {
        const actual = hasOutboundAgentApiReport(tp, check.recipientId);
        assert.equal(
          actual,
          check.expected,
          `hasOutboundAgentApiReport mismatch for ${check.label || check.recipientId}`
        );
      }
      return { id: spec.id, ok: true };
    }

    if (kind === 'transcript_extract_ids') {
      const res = extractPromptSessionIds(spec.action?.input || '', spec.action?.options || {});
      if (Array.isArray(spec.expect?.ids)) {
        assert.deepEqual(res.ids, spec.expect.ids);
      }
      if (spec.expect?.maxCount !== undefined) {
        assert.ok(res.ids.length <= spec.expect.maxCount);
      }
      return { id: spec.id, ok: true };
    }

    if (kind === 'settings_validate_model') {
      for (const c of spec.expect?.cases || []) {
        const v = validateDispatchModel(c.model, c.effective || undefined);
        assert.equal(v.ok, c.ok, `Model validation mismatch for "${c.model}"`);
        if (c.cliModel !== undefined) {
          assert.equal(normalizeModelForAgentApi(c.model), c.cliModel, `Alias mismatch for "${c.model}"`);
        }
      }
      return { id: spec.id, ok: true };
    }

    if (kind === 'roadmap_dag') {
      const graph = evaluateRoadmapGraph(spec.action?.roadmap || {});
      if (spec.expect?.hasCycle !== undefined) {
        assert.equal(graph.hasCycle, spec.expect.hasCycle);
      }
      if (spec.expect?.overlapCount !== undefined) {
        assert.equal(graph.overlaps.length, spec.expect.overlapCount);
      }
      if (Array.isArray(spec.expect?.readyIds)) {
        assert.deepEqual(graph.readyIds, spec.expect.readyIds);
      }
      return { id: spec.id, ok: true };
    }

    if (kind === 'inbox_attention_prune') {
      const nowMs = Number(spec.action?.nowMs || Date.now());
      const summary = summarizeInbox(spec.action?.inbox || {}, {
        nowMs,
        activeControllerId: spec.action?.activeControllerId || '',
      });
      const banner = buildUnifiedAttentionBanner(summary, {
        activeControllerId: spec.action?.activeControllerId || '',
        controllerCompactions: Number(spec.action?.controllerCompactions || 0),
        compactionThreshold: Number(spec.action?.compactionThreshold || 5),
        handoverIgnored: Boolean(spec.action?.handoverIgnored),
      });
      if (spec.expect?.remainingInboxCount !== undefined) {
        assert.equal(summary.items.length, spec.expect.remainingInboxCount);
      }
      if (spec.expect?.bannerCount !== undefined) {
        assert.equal(banner.items.length, spec.expect.bannerCount);
      }
      return { id: spec.id, ok: true };
    }

    if (kind === 'hook') {
      if (spec.setup?.registryMarkdown) {
        const rel = spec.setup.registryRelPath || '.agents/SESSION-REGISTRY.md';
        const abs = join(ws, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, spec.setup.registryMarkdown, 'utf8');
      }
      if (spec.setup?.roadmapJson) {
        const rmPath = join(ws, '.agents', 'roadmap.json');
        mkdirSync(dirname(rmPath), { recursive: true });
        writeFileSync(rmPath, JSON.stringify(spec.setup.roadmapJson, null, 2), 'utf8');
      }
      for (const [convKey, rows] of Object.entries(spec.setup?.transcripts || {})) {
        const tp = makeTranscriptPath(appData, convKey);
        const content = rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
        writeFileSync(tp, content, 'utf8');
      }
      if (spec.setup?.stateJson) {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(join(dataDir, 'state.json'), JSON.stringify(spec.setup.stateJson, null, 2), 'utf8');
      }

      const calls = Array.isArray(spec.action?.calls) ? spec.action.calls : [spec.action];
      for (let i = 0; i < calls.length; i += 1) {
        const call = calls[i];
        if (call.writeRegistryMarkdown) {
          const rel = spec.setup?.registryRelPath || '.agents/SESSION-REGISTRY.md';
          writeFileSync(join(ws, rel), call.writeRegistryMarkdown, 'utf8');
        }
        const env = {
          ...process.env,
          ANTIGRAVITY_APP_DATA_DIR: appData,
          AGY_CONTROL_TOWER_DATA_DIR: dataDir,
          ...(call.env || {}),
        };
        const out = execFileSync(process.execPath, [HOOK_SCRIPT, call.eventName], {
          input: JSON.stringify(call.payload || {}),
          encoding: 'utf8',
          env,
        });
        const parsed = JSON.parse(out);
        const exp = call.expect || (calls.length === 1 ? spec.expect : {}) || {};

        if (exp.decision !== undefined) {
          assert.equal(parsed.decision, exp.decision);
        }
        const injectedText = (parsed.injectSteps || [])
          .map((s) => s?.systemMessage?.systemMessage || '')
          .join('\n');
        for (const sub of exp.contains || []) {
          assert.ok(injectedText.includes(sub), `Call #${i + 1}: expected output to include "${sub}", got: ${injectedText}`);
        }
        for (const sub of exp.notContains || []) {
          assert.equal(injectedText.includes(sub), false, `Call #${i + 1}: expected output NOT to include "${sub}"`);
        }
        if (exp.flightEvent) {
          const events = readFlightEvents(dataDir, { limit: 20 });
          assert.ok(
            events.some((ev) => ev.event === exp.flightEvent),
            `Expected flight log event "${exp.flightEvent}"`
          );
        }
        if (exp.focusInFlight !== undefined) {
          const curInbox = loadWorkspaceInbox(dataDir, ws);
          assert.equal(curInbox.focus.inFlight, exp.focusInFlight);
        }
        if (exp.minInboxItems !== undefined) {
          const curInbox = loadWorkspaceInbox(dataDir, ws);
          assert.ok(curInbox.items.length >= exp.minInboxItems);
        }
      }
      return { id: spec.id, ok: true };
    }

    throw new Error(`Unsupported replay fixture kind: ${kind}`);
  } finally {
    sb.cleanup();
  }
}

export function runAllReplays(dir = DEFAULT_REPLAY_DIR) {
  const fixtures = loadReplayFixtures(dir);
  const results = [];
  for (const fx of fixtures) {
    try {
      runReplayFixture(fx);
      results.push({ id: fx.id, file: fx.file, title: fx.title, ok: true });
    } catch (err) {
      results.push({ id: fx.id, file: fx.file, title: fx.title, ok: false, error: err?.message || String(err) });
    }
  }
  return {
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

const SCRUB_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function createReplaySkeletonFromFlightEvent(ev, idSuffix = '') {
  const scrub = (s, max) => sanitizeLogString(s, max).replace(SCRUB_UUID_RE, '${OTHER_ID}');
  const slug = scrub(ev?.event || 'incident', 32)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const id = idSuffix || `replay-${slug || 'incident'}`;
  return {
    id,
    title: `Frozen incident: ${scrub(ev?.event || 'unknown', 80)}`,
    incidentDate: String(ev?.ts || new Date().toISOString()).slice(0, 10),
    category: scrub(ev?.source || 'hook', 32),
    description: scrub(ev?.message || 'Frozen from flight recorder event', 200),
    kind: 'hook',
    setup: {
      registryRelPath: '.agents/SESSION-REGISTRY.md',
      registryMarkdown: '# Registry\n## 二、常驻主交流总控会话\n- **当前现役总控会话**：`${CTRL_ID}`（状态：`ONLINE`）\n',
    },
    action: {
      eventName: 'PreInvocation',
      payload: {
        conversationId: '${CTRL_ID}',
        workspacePaths: ['${WORKSPACE}'],
        lastUserInput: '请补充复现输入',
      },
    },
    expect: {
      notContains: ['UNEXPECTED_FAILURE'],
    },
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const freezeLatest = args.includes('--freeze-latest');

  if (freezeLatest) {
    const dataArg = args.find((a) => a.startsWith('--data-dir='));
    const outArg = args.find((a) => a.startsWith('--out='));
    const dataDir = dataArg ? resolve(dataArg.slice('--data-dir='.length)) : resolvePluginDataDir();
    const events = readFlightEvents(dataDir, { limit: 20, level: 'warn_or_error' });
    if (events.length === 0) {
      console.error('未在黑匣子日志中找到 warn/error 事故事件，无需冻结。');
      process.exit(1);
    }
    const skeleton = createReplaySkeletonFromFlightEvent(events[0]);
    const txt = `${JSON.stringify(skeleton, null, 2)}\n`;
    if (outArg) {
      writeFileSync(resolve(outArg.slice('--out='.length)), txt, 'utf8');
      console.log(`OK: 已导出脱敏回放骨架至 ${outArg.slice('--out='.length)}`);
    } else {
      process.stdout.write(txt);
    }
    process.exit(0);
  }

  const summary = runAllReplays();
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    for (const r of summary.results) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'} [${r.id}] ${r.title}${r.error ? ` -> ${r.error}` : ''}`);
    }
    console.log(`----\nReplays: ${summary.passed}/${summary.total} passed`);
  }
  process.exit(summary.failed > 0 ? 1 : 0);
}
