#!/usr/bin/env node
/**
 * Control Tower Ring 2: Read-Only Telemetry Miner & Improvement Proposal Engine
 * Mines local Antigravity transcripts + control-tower flight logs (never modifies runtime state)
 * and clusters friction into sanitized, evidence-backed engineering proposals.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAppDataDirs, resolvePluginDataDir } from '../plugin/lib/paths.mjs';
import { sanitizeLogString, summarizeFlightEvents } from '../plugin/lib/logger.mjs';
import { inspectTranscript, loadPluginState } from '../plugin/lib/transcript.mjs';

const MAX_READ_BYTES_PER_FILE = 8 * 1024 * 1024;

function parseArgs(argv) {
  const opts = {
    days: 7,
    appDataDir: '',
    dataDir: '',
    maxConversations: 120,
    json: false,
    out: '',
  };
  for (const arg of argv) {
    if (arg === '--json') {
      opts.json = true;
    } else if (arg.startsWith('--days=')) {
      const n = Number(arg.slice('--days='.length));
      if (Number.isFinite(n) && n > 0) opts.days = Math.min(90, n);
    } else if (arg.startsWith('--max=')) {
      const n = Number(arg.slice('--max='.length));
      if (Number.isFinite(n) && n > 0) opts.maxConversations = Math.min(500, Math.trunc(n));
    } else if (arg.startsWith('--app-data=')) {
      opts.appDataDir = arg.slice('--app-data='.length).trim();
    } else if (arg.startsWith('--data-dir=')) {
      opts.dataDir = arg.slice('--data-dir='.length).trim();
    } else if (arg.startsWith('--out=')) {
      opts.out = arg.slice('--out='.length).trim();
    }
  }
  return opts;
}

function readTranscriptLinesSafe(filePath) {
  let fd;
  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.size === 0) return [];
    const offset = Math.max(0, st.size - MAX_READ_BYTES_PER_FILE);
    const len = st.size - offset;
    fd = openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(len);
    let total = 0;
    while (total < len) {
      const n = readSync(fd, buf, total, len - total, offset + total);
      if (n <= 0) break;
      total += n;
    }
    const raw = buf.subarray(0, total).toString('utf8');
    if (offset === 0) {
      return raw.split(/\r?\n/).filter(Boolean);
    }
    const firstNl = raw.indexOf('\n');
    const clean = firstNl >= 0 ? raw.slice(firstNl + 1) : '';
    return clean.split(/\r?\n/).filter(Boolean);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function pct(num, den) {
  if (!den || den <= 0) return null;
  return Math.round((num / den) * 1000) / 10;
}

function makeModeBucket() {
  return {
    sessions: 0,
    steps: 0,
    switches: 0,
    uncachedTokens: 0,
    cacheReadTokens: 0,
    editMismatches: 0,
  };
}

function finalizeModeBucket(mb) {
  const totIn = mb.uncachedTokens + mb.cacheReadTokens;
  return {
    sessions: mb.sessions,
    steps: mb.steps,
    switches: mb.switches,
    cacheHitPct: pct(mb.cacheReadTokens, totIn),
    avgUncached: mb.steps > 0 ? Math.round(mb.uncachedTokens / mb.steps) : 0,
    editMismatches: mb.editMismatches,
  };
}

export function mineTelemetryAndLogs({
  days = 7,
  appDataDir = '',
  dataDir = '',
  maxConversations = 120,
  env = process.env,
} = {}) {
  const nowMs = Date.now();
  const windowMs = Math.max(1, Number(days) || 7) * 86400 * 1000;
  const sinceMs = nowMs - windowMs;

  const resolvedAppDirs = appDataDir ? [resolve(appDataDir)] : resolveAppDataDirs({ env });
  const resolvedDataDir = dataDir ? resolve(dataDir) : resolvePluginDataDir({ env });

  const candidates = [];
  for (const appDir of resolvedAppDirs) {
    const brainDir = join(appDir, 'brain');
    if (!existsSync(brainDir)) continue;
    let entries = [];
    try {
      entries = readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const tp = join(brainDir, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (!existsSync(tp)) continue;
      try {
        const st = statSync(tp);
        if (st.mtimeMs >= sinceMs) {
          candidates.push({ convPrefix: ent.name.slice(0, 8), tp, mtimeMs: st.mtimeMs });
        }
      } catch {
        // skip unreadable entry
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const selected = candidates.slice(0, maxConversations);

  const byModel = new Map();
  let totalPlannerSteps = 0;
  let sameModelSteps = 0;
  let sameModelCache = 0;
  let sameModelTotalIn = 0;
  let switchSteps = 0;
  let switchCache = 0;
  let switchTotalIn = 0;
  let totalToolCalls = 0;
  let errorSteps = 0;
  let editMismatchCount = 0;
  const editMismatchByModel = new Map();
  const highCompactionSessions = [];
  const modeBuckets = {
    customOrchestrator: makeModeBucket(),
    legacyOrchestrator: makeModeBucket(),
    singleModel: makeModeBucket(),
  };

  const readonlyCache = existsSync(resolvedDataDir)
    ? loadPluginState(resolvedDataDir).transcriptCache || {}
    : {};

  for (const item of selected) {
    let lines = [];
    try {
      lines = readTranscriptLinesSafe(item.tp);
    } catch {
      continue;
    }

    const inspected = inspectTranscript(item.tp, { cacheEntry: readonlyCache[item.tp] || null });
    if ((inspected.info.compactions || 0) >= 5) {
      highCompactionSessions.push({
        conv: item.convPrefix,
        compactions: inspected.info.compactions,
        lastModel: inspected.info.lastModel || 'unknown',
        steps: inspected.info.maxStepIndex || inspected.info.lineCount,
      });
    }

    let prevModel = '';
    let lastPlannerModel = 'unknown';
    const convModels = new Set();
    let convHasExitPlanMode = false;
    let convSteps = 0;
    let convSwitches = 0;
    let convUncached = 0;
    let convCacheRead = 0;
    let convEditMismatch = 0;

    for (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object') continue;

      if (obj.type === 'PLANNER_RESPONSE' && obj.model) {
        const m = String(obj.model);
        lastPlannerModel = m;
        convModels.add(m);
        convSteps += 1;
        totalPlannerSteps += 1;

        const uncached = Math.max(0, Number(obj.input_tokens || 0));
        const cacheRead = Math.max(0, Number(obj.cache_read_tokens || 0));
        const outTok = Math.max(0, Number(obj.output_tokens || 0));
        const totIn = uncached + cacheRead;
        convUncached += uncached;
        convCacheRead += cacheRead;

        if (!byModel.has(m)) {
          byModel.set(m, {
            model: m,
            steps: 0,
            uncachedTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
            switchesInto: 0,
          });
        }
        const bucket = byModel.get(m);
        bucket.steps += 1;
        bucket.uncachedTokens += uncached;
        bucket.cacheReadTokens += cacheRead;
        bucket.outputTokens += outTok;

        if (prevModel && prevModel !== m) {
          switchSteps += 1;
          switchCache += cacheRead;
          switchTotalIn += totIn;
          bucket.switchesInto += 1;
          convSwitches += 1;
        } else if (prevModel && prevModel === m) {
          sameModelSteps += 1;
          sameModelCache += cacheRead;
          sameModelTotalIn += totIn;
        }
        prevModel = m;
      }

      if (Array.isArray(obj.tool_calls)) {
        totalToolCalls += obj.tool_calls.length;
        if (obj.tool_calls.some((tc) => tc?.name === 'exit_plan_mode')) {
          convHasExitPlanMode = true;
        }
      }
      if (obj.status === 'ERROR') {
        errorSteps += 1;
      }
      if (typeof obj.content === 'string' && obj.content.includes('target content not found')) {
        editMismatchCount += 1;
        convEditMismatch += 1;
        editMismatchByModel.set(lastPlannerModel, (editMismatchByModel.get(lastPlannerModel) || 0) + 1);
      }
    }

    if (convSteps > 0) {
      let modeKey = 'singleModel';
      if (convModels.has('gemini-flash-worker-agy')) {
        modeKey = 'legacyOrchestrator';
      } else if (convHasExitPlanMode && convModels.size >= 2) {
        modeKey = 'customOrchestrator';
      } else if (convModels.has('gemini-pro-orchestrator') || convModels.has('gemini-pro-orchestrator-neon')) {
        modeKey = convHasExitPlanMode ? 'customOrchestrator' : 'legacyOrchestrator';
      }
      const mb = modeBuckets[modeKey];
      mb.sessions += 1;
      mb.steps += convSteps;
      mb.switches += convSwitches;
      mb.uncachedTokens += convUncached;
      mb.cacheReadTokens += convCacheRead;
      mb.editMismatches += convEditMismatch;
    }
  }

  const models = [...byModel.values()]
    .map((m) => {
      const totIn = m.uncachedTokens + m.cacheReadTokens;
      return {
        model: m.model,
        steps: m.steps,
        cacheHitPct: pct(m.cacheReadTokens, totIn),
        avgUncached: m.steps > 0 ? Math.round(m.uncachedTokens / m.steps) : 0,
        outputTokens: m.outputTokens,
        switchesInto: m.switchesInto,
      };
    })
    .sort((a, b) => b.steps - a.steps);

  const sameModelCachePct = pct(sameModelCache, sameModelTotalIn);
  const switchCachePct = pct(switchCache, switchTotalIn);

  const flight = summarizeFlightEvents(resolvedDataDir, { windowMs });

  const proposals = [];

  if (
    switchSteps >= 3 &&
    sameModelCachePct !== null &&
    switchCachePct !== null &&
    sameModelCachePct - switchCachePct >= 15
  ) {
    proposals.push({
      id: 'PROP-CACHE-SWITCH',
      severity: switchCachePct < 55 ? 'high' : 'medium',
      category: 'cache_routing',
      title: '模型切层导致连续缓存命中显著下滑',
      evidence: `同模型连续步命中率 ${sameModelCachePct}% (${sameModelSteps} 步) vs 切模型步命中率 ${switchCachePct}% (${switchSteps} 步)`,
      recommendation:
        '检查高频短交互会话是否仍误选双层模型，或在规划阶段一次写透目标路径与验收命令以降低中途回切频率。',
    });
  }

  if (editMismatchCount >= 3) {
    const topOffenders = [...editMismatchByModel.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([m, c]) => `${m}(${c})`)
      .join(', ');
    proposals.push({
      id: 'PROP-EDIT-MISMATCH',
      severity: editMismatchCount >= 10 ? 'high' : 'medium',
      category: 'execution_discipline',
      title: '检测到集中出现的 edit_file 目标文本不匹配错误',
      evidence: `近 ${days} 天累计 ${editMismatchCount} 次 target content not found；主要来源: ${topOffenders}`,
      recommendation:
        '优先确认 Orchestrator 执行层已升配至 Gemini 4 Hydrogen (High/Extra High)，并在派单模板持续强化先 read_file 再 edit_file 及连续 2 次不匹配止损纪律。',
    });
  }

  if (highCompactionSessions.length > 0) {
    proposals.push({
      id: 'PROP-COMPACTION-AGING',
      severity: 'medium',
      category: 'session_lifecycle',
      title: '存在高上下文压缩次数会话，建议评估换届或切干净子会话',
      evidence: `共 ${highCompactionSessions.length} 个会话压缩 >= 5 次（示例: ${highCompactionSessions
        .slice(0, 3)
        .map((s) => `#${s.conv}:${s.compactions}次`)
        .join(', ')}）`,
      recommendation:
        '核查对应工作区总控是否需要按换届模板平滑交接，或将重度探索任务拆离至隐藏执行面避免污染主线。',
    });
  }

  if ((flight.byLevel?.error || 0) > 0) {
    proposals.push({
      id: 'PROP-FLIGHT-ERRORS',
      severity: 'high',
      category: 'plugin_reliability',
      title: '插件黑匣子日志捕获到运行态错误，建议冻结为 L2 回放样本',
      evidence: `近 ${days} 天共捕获 ${flight.byLevel.error} 条 error 事件（最新: ${sanitizeLogString(
        flight.recentErrors?.[0]?.event || 'unknown',
        60
      )}）`,
      recommendation:
        '运行 node scripts/ct-replay.mjs --freeze-latest 将最新事故现场导出至 tests/replays/，先复现红灯再修复转绿。',
    });
  }

  if ((flight.slowCount || 0) >= 3) {
    proposals.push({
      id: 'PROP-SLOW-OPS',
      severity: 'medium',
      category: 'performance',
      title: '检测到多次 Hook 或 Sidecar 慢调用 (>= 100ms)',
      evidence: `近 ${days} 天黑匣子记录 ${flight.slowCount} 次慢调用`,
      recommendation:
        '检查对应大体积 transcript.jsonl 或台账解析热点，确保增量缓存命中且无阻塞 I/O。',
    });
  }

  if ((flight.guardBlockedCount || 0) >= 2) {
    proposals.push({
      id: 'PROP-WRITE-GUARD',
      severity: 'low',
      category: 'workflow_friction',
      title: '专职会话多次触发 PreToolUse 台账写保护',
      evidence: `近 ${days} 天共拦截 ${flight.guardBlockedCount} 次非总控改写 SESSION-REGISTRY.md`,
      recommendation:
        '核查派单开场词是否显式强调「严禁直接修改 SESSION-REGISTRY.md」并确保专职会话已入账触发 SessionStart 提醒。',
    });
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    windowDays: days,
    scannedConversations: selected.length,
    totalPlannerSteps,
    totalToolCalls,
    errorSteps,
    editMismatchCount,
    cacheSummary: {
      sameModelSteps,
      sameModelCachePct,
      switchSteps,
      switchCachePct,
    },
    models,
    orchestratorComparison: {
      customOrchestrator: finalizeModeBucket(modeBuckets.customOrchestrator),
      legacyOrchestrator: finalizeModeBucket(modeBuckets.legacyOrchestrator),
      singleModel: finalizeModeBucket(modeBuckets.singleModel),
    },
    highCompactionSessions: highCompactionSessions.slice(0, 10),
    flightSummary: {
      total: flight.total,
      byLevel: flight.byLevel,
      slowCount: flight.slowCount,
      guardBlockedCount: flight.guardBlockedCount,
      wakeSkippedCount: flight.wakeSkippedCount,
    },
    proposals,
  };
}

export function formatMinerMarkdown(report) {
  const lines = [
    `# Control Tower 遥测复盘与改进提案报告`,
    ``,
    `- 生成时间: ${report.generatedAt}`,
    `- 统计窗口: 近 ${report.windowDays} 天 | 扫描会话: ${report.scannedConversations} 个 | 规划步数: ${report.totalPlannerSteps} | 工具调用: ${report.totalToolCalls}`,
    `- 缓存对比: 同模型连续步 ${report.cacheSummary.sameModelCachePct ?? 'N/A'}% (${report.cacheSummary.sameModelSteps} 步) vs 切模型步 ${report.cacheSummary.switchCachePct ?? 'N/A'}% (${report.cacheSummary.switchSteps} 步)`,
    `- 工具报错步: ${report.errorSteps} | edit_file 不匹配: ${report.editMismatchCount}`,
    `- 黑匣子事件: 共 ${report.flightSummary.total} 条 (error=${report.flightSummary.byLevel?.error || 0}, warn=${report.flightSummary.byLevel?.warn || 0}, slow=${report.flightSummary.slowCount || 0}, guardBlocked=${report.flightSummary.guardBlockedCount || 0})`,
    ``,
    `## 模型分层实测概览`,
    ``,
    `| 模型 ID | 步数 | 缓存命中率 | 平均冷输入 | 切入次数 |`,
    `| --- | --- | --- | --- | --- |`,
  ];

  if (report.models.length === 0) {
    lines.push(`| (统计窗口内无记录) | 0 | N/A | 0 | 0 |`);
  } else {
    for (const m of report.models.slice(0, 12)) {
      const safeModel = sanitizeLogString(m.model, 80).replace(/\|/g, '/').replace(/`/g, '');
      lines.push(
        `| \`${safeModel}\` | ${m.steps} | ${m.cacheHitPct ?? 'N/A'}% | ${m.avgUncached} | ${m.switchesInto} |`
      );
    }
  }

  const oc = report.orchestratorComparison || {};
  lines.push(
    ``,
    `## 新版 Orchestrator vs 纯单模型实测对比`,
    ``,
    `| 运行模式 | 会话数 | 规划步数 | 切层次数 | 平均缓存命中 | 平均冷输入 | edit_file 失配 |`,
    `| --- | --- | --- | --- | --- | --- | --- |`
  );
  for (const [label, key] of [
    ['新版自定义 Orchestrator', 'customOrchestrator'],
    ['旧版 Orchestrator', 'legacyOrchestrator'],
    ['纯单模型会话', 'singleModel'],
  ]) {
    const b = oc[key] || { sessions: 0, steps: 0, switches: 0, cacheHitPct: null, avgUncached: 0, editMismatches: 0 };
    lines.push(
      `| ${label} | ${b.sessions} | ${b.steps} | ${b.switches} | ${b.cacheHitPct ?? 'N/A'}% | ${b.avgUncached} | ${b.editMismatches} |`
    );
  }

  lines.push(``, `## 自动聚类改进提案 (${report.proposals.length} 条)`, ``);
  if (report.proposals.length === 0) {
    lines.push(`当前窗口内未发现显著摩擦热点，系统运行健康。`);
  } else {
    for (const p of report.proposals) {
      lines.push(
        `### [${p.severity.toUpperCase()}] ${p.id}: ${p.title}`,
        `- 分类: \`${p.category}\``,
        `- 实证依据: ${p.evidence}`,
        `- 改进建议: ${p.recommendation}`,
        ``
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const report = mineTelemetryAndLogs(opts);
  const output = opts.json ? `${JSON.stringify(report, null, 2)}\n` : formatMinerMarkdown(report);
  if (opts.out) {
    writeFileSync(resolve(opts.out), output, 'utf8');
    console.log(`OK: 报告已写入 ${opts.out} (${report.proposals.length} 条提案)`);
  } else {
    process.stdout.write(output);
  }
}
