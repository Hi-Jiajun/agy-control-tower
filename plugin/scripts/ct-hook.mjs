#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findRegistryInWorkspaces,
  resolvePluginDataDir,
} from '../lib/paths.mjs';
import {
  findActiveWorkerSession,
  isActiveController,
  parseRegistry,
} from '../lib/registry.mjs';
import { resolveEffectiveSettings } from '../lib/settings.mjs';
import {
  extractPromptSessionIds,
  hasOutboundAgentApiReport,
  inspectTranscript,
  isValidConvIdOrPrefix,
  loadPluginState,
  resolveBrainTranscript,
  savePluginState,
} from '../lib/transcript.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');

function readInstalledPluginVersion() {
  try {
    const raw = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'plugin.json'), 'utf8'));
    return typeof raw?.version === 'string' ? raw.version.trim() : '';
  } catch {
    return '';
  }
}

function readStdinSync() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function expandUserPath(raw) {
  if (typeof raw !== 'string') return '';
  const t = raw.trim();
  if (!t) return '';
  if (t === '~') return resolve(homedir());
  if (t.startsWith('~/')) {
    return resolve(homedir(), t.slice(2));
  }
  return t;
}

function resolveCanonicalPath(rawPath, baseDir = '') {
  const expanded = expandUserPath(rawPath);
  if (!expanded) return '';
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir || process.cwd(), expanded);
  if (existsSync(abs)) {
    try {
      return realpathSync(abs);
    } catch {
      return abs;
    }
  }
  const parts = [];
  let cur = abs;
  for (let i = 0; i < 16; i += 1) {
    if (existsSync(cur)) {
      try {
        return join(realpathSync(cur), ...parts.reverse());
      } catch {
        return abs;
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    parts.push(basename(cur));
    cur = parent;
  }
  return abs;
}

function resolveSelfTranscript(payload, convId, hintPath) {
  const tp = resolveCanonicalPath(payload.transcriptPath || '');
  if (tp && existsSync(tp)) return tp;
  const res = resolveBrainTranscript(convId, { hintPath });
  if (res.status === 'ok' && res.path) return res.path;
  return '';
}

function sameControllerId(a, b) {
  if (!a || !b) return false;
  const x = String(a).trim().toLowerCase();
  const y = String(b).trim().toLowerCase();
  return x === y || (x.length >= 8 && y.length >= 8 && (x.startsWith(y) || y.startsWith(x)));
}

function hasValidController(parsedReg) {
  const ctrlId = String(parsedReg?.controller?.currentControllerId || '').trim();
  return Boolean(ctrlId && isValidConvIdOrPrefix(ctrlId));
}

function upsertAttention(state, item) {
  const list = Array.isArray(state.pendingAttention) ? [...state.pendingAttention] : [];
  const idx = list.findIndex((x) => x && x.id === item.id);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...item };
  } else {
    list.push(item);
  }
  state.pendingAttention = list;
}

function sendAgentApiMessage(recipientId, title, message) {
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  const file = exe || 'agentapi';
  const args = exe
    ? ['agentapi', 'send-message', '--title', title, recipientId, message]
    : ['send-message', '--title', title, recipientId, message];
  execFileSync(file, args, {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function handlePreToolUse(payload, regFound, parsedReg, resolved, convId) {
  const guardMode = resolved.plugin.registryWriteGuard || 'ask';
  if (guardMode === 'off') {
    process.stdout.write('{"decision":"allow"}\n');
    return;
  }

  const args = payload?.toolCall?.args && typeof payload.toolCall.args === 'object' ? payload.toolCall.args : {};
  const rawTarget = args.Path || args.TargetFile || args.path || args.file || '';
  if (typeof rawTarget !== 'string' || !rawTarget.trim()) {
    process.stdout.write('{"decision":"allow"}\n');
    return;
  }

  const baseDir = String(payload.cwd || regFound.workspace || '');
  const targetReal = resolveCanonicalPath(rawTarget, baseDir);
  const regReal = resolveCanonicalPath(regFound.absPath);
  if (!targetReal || targetReal !== regReal) {
    process.stdout.write('{"decision":"allow"}\n');
    return;
  }

  if (!hasValidController(parsedReg) || isActiveController(convId, parsedReg)) {
    process.stdout.write('{"decision":"allow"}\n');
    return;
  }

  const decision = guardMode === 'deny' ? 'deny' : 'ask';
  const reason =
    `[control-tower 台账写保护] SESSION-REGISTRY.md 已由现役总控会话接管，` +
    `当前会话非现役总控。如需入账或换届，请由现役总控更新或在 Control Tower 看板操作。`;
  process.stdout.write(`${JSON.stringify({ decision, reason })}\n`);
}

function handleSessionStart(regFound, parsedReg, resolved, convId) {
  const isCtrl = isActiveController(convId, parsedReg);
  if (isCtrl) {
    const leaseStatus = ((parsedReg.lease || {}).lockStatus || '未知').trim();
    const activeCount = (parsedReg.activeSessions || []).length;
    const lockText =
      resolved.effective.exclusiveLeaseEnabled === false
        ? '无独占资源模式'
        : `独占锁状态: ${leaseStatus}`;
    const regTag = regFound.isManaged ? `${regFound.absPath} (PLUGIN_DATA 零侵入托管)` : regFound.absPath;

    const overrideNotes = [];
    if (resolved.docs['model-routing.md']?.source && resolved.docs['model-routing.md'].source !== 'builtin') {
      overrideNotes.push(
        `路由覆盖(${resolved.docs['model-routing.md'].source}): ${resolved.docs['model-routing.md'].activePath}`
      );
    }
    if (resolved.docs['templates.md']?.source && resolved.docs['templates.md'].source !== 'builtin') {
      overrideNotes.push(
        `模板覆盖(${resolved.docs['templates.md'].source}): ${resolved.docs['templates.md'].activePath}`
      );
    }
    const overrideSuffix = overrideNotes.length > 0 ? ` | ${overrideNotes.join(' | ')}` : '';
    const schemaIssues = [];
    if (resolved.effective.exclusiveLeaseEnabled !== false && !((parsedReg.lease || {}).lockStatus || '').trim()) {
      schemaIssues.push('第 1 节未匹配标准独占资源租约结构');
    }
    if ((parsedReg.activeSessions || []).some((s) => !s.conversationId)) {
      schemaIssues.push('第 3 节存在无有效会话 ID 的占位行');
    }
    const schemaHint =
      schemaIssues.length > 0
        ? ` | 台账格式提示: ${schemaIssues.join('；')}，建议按 control-tower 标准模板对齐`
        : '';
    const msg =
      `[control-tower 总控就位] 已核验当前会话为工作区现役总控。` +
      `台账: ${regTag} | ${lockText} | 活跃专职会话: ${activeCount} 个 | ` +
      `代决策档位: ${resolved.effective.effectiveAutonomy} (${resolved.effective.autonomySource}) | ` +
      `换届阈值: ${resolved.effective.controllerCompactionThreshold} 次压缩` +
      `${overrideSuffix}${schemaHint}。`;
    process.stdout.write(
      `${JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: msg } }] })}\n`
    );
    return;
  }

  if (resolved.plugin.dualRoleHookEnabled === false) {
    process.stdout.write('{}\n');
    return;
  }

  const workerRow = findActiveWorkerSession(convId, parsedReg);
  if (!workerRow || String(workerRow.status || '').toUpperCase() === 'DONE') {
    process.stdout.write('{}\n');
    return;
  }

  const ctrlId = String(parsedReg?.controller?.currentControllerId || '').trim();
  const lockDesc =
    resolved.effective.exclusiveLeaseEnabled === false
      ? '无独占资源模式'
      : workerRow.lockStatus || '纯离线无锁';
  const reportHint = hasValidController(parsedReg)
    ? `遇到需拍板分叉或完成收口时，请通过 agentapi send-message "${ctrlId}" "[CT_REPORT:DECISION] ..." 或 "[CT_REPORT:DONE] ..." 向总控汇报。`
    : '完成收口后请输出清晰交付清单与验证输出供总控入账。';
  const workerMsg =
    `[control-tower 专职会话约束] 任务: ${workerRow.topic || '-'} | 资源边界: ${lockDesc} | ` +
    `严禁直接修改 ${regFound.relPath}（由总控或看板独占写入）。${reportHint}`;
  process.stdout.write(
    `${JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: workerMsg } }] })}\n`
  );
}

function handlePreInvocation(payload, regFound, parsedReg, resolved, dataDir, hintPath, convId) {
  if (!isActiveController(convId, parsedReg)) {
    process.stdout.write('{}\n');
    return;
  }

  const state = loadPluginState(dataDir);
  let stateDirty = false;
  const injectSteps = [];
  const lastInput = String(payload.lastUserInput || '');

  // 1) Intake routing: Stage receipt vs Decision request vs Bare/Multi-ID lookup
  if (lastInput.includes('[CT_AUTO_RECEIPT]')) {
    const receiptNote =
      `[control-tower 阶段收口指引] 已收到专职会话自动阶段回执，请核查尾步与交付清单、同步更新 ${regFound.absPath}，` +
      `并在全部阶段任务收口后向用户输出整理好的成果汇总并结束回合以触发 Antigravity 原生系统通知（严禁使用外部桌面通知命令）。`;
    injectSteps.push({ systemMessage: { systemMessage: receiptNote } });
  } else {
    if (lastInput.includes('[CT_REPORT:DECISION]')) {
      const level = resolved.effective.effectiveAutonomy;
      const decisionNote =
        `[control-tower 代决策指引] 当前生效代决策档位: ${level} (${resolved.effective.autonomySource})。` +
        `autonomous 档可直接用 agentapi send-message 自动拍板回复专职会话；balanced 档在局部细节内自决，涉及接口/架构分叉、范围变更或连续失败请调用 ask_question 通知用户；strict 档一律通过 ask_question 交由用户决定。`;
      injectSteps.push({ systemMessage: { systemMessage: decisionNote } });
      upsertAttention(state, {
        id: `decision-${Date.now().toString(36)}`,
        kind: 'decision',
        workspace: regFound.workspace,
        controllerId: convId,
        summary: lastInput.replace(/\s+/g, ' ').trim().slice(0, 140),
        updatedAt: Date.now(),
      });
      stateDirty = true;
    }

    const knownIds = (parsedReg.activeSessions || [])
      .map((s) => s.conversationId)
      .filter(Boolean);
    const { ids } = extractPromptSessionIds(lastInput, {
      maxCandidates: resolved.plugin.maxLookupCandidates,
      maxInputLength: resolved.plugin.maxLookupInputLength,
      knownIds,
    });
    for (const cand of ids) {
      if (sameControllerId(cand, convId)) continue;
      const found = resolveBrainTranscript(cand, { hintPath });
      if (found.status === 'ok' && found.path) {
        const prevCache = state.transcriptCache[found.path] || null;
        const { info, nextCacheEntry } = inspectTranscript(found.path, { cacheEntry: prevCache });
        if (nextCacheEntry && nextCacheEntry !== prevCache) {
          state.transcriptCache[found.path] = nextCacheEntry;
          stateDirty = true;
        }
        const stepLabel = info.maxStepIndex || info.lineCount;
        const goal = info.goal || '(未捕获首条用户输入)';
        const model = info.lastModel || '未知';
        const updated = info.lastUpdatedAt || '未知';
        const st = info.lastStatus || '未知';
        const err = info.lastError ? ` | 最近报错: ${info.lastError}` : '';
        const note =
          `[control-tower 裸ID速查] 会话 ${found.conversationId} | 目标: ${goal} | ` +
          `步数: ${stepLabel} (记录 ${info.lineCount} 条) | 模型: ${model} | ` +
          `更新: ${updated} | 状态: ${st} | 压缩次数: ${info.compactions}${err}`;
        injectSteps.push({ systemMessage: { systemMessage: note } });
      } else if (found.status === 'ambiguous' && found.matches.length > 0) {
        const preview = found.matches.slice(0, 4).join(', ');
        const note = `[control-tower 裸ID速查] 前缀 ${cand} 匹配多个会话 (${preview})，请补全更长 ID 后再入账。`;
        injectSteps.push({ systemMessage: { systemMessage: note } });
      }
    }
  }

  // 2) One-shot plugin version upgrade notice & flexible anti-aging handover warning
  const selfTp = resolveSelfTranscript(payload, convId, hintPath);
  let selfInfo = null;
  if (selfTp) {
    const prevSelfCache = state.transcriptCache[selfTp] || null;
    const inspected = inspectTranscript(selfTp, { cacheEntry: prevSelfCache });
    selfInfo = inspected.info;
    if (inspected.nextCacheEntry && inspected.nextCacheEntry !== prevSelfCache) {
      state.transcriptCache[selfTp] = inspected.nextCacheEntry;
      stateDirty = true;
    }
  }

  const currentVersion = readInstalledPluginVersion();
  const prevCtrlEntry = state.controllers[convId] || {};
  let nextCtrlEntry = { ...prevCtrlEntry };
  let ctrlDirty = false;

  if (currentVersion && prevCtrlEntry.lastSyncedVersion !== currentVersion) {
    const hasPriorHistory =
      Boolean(prevCtrlEntry.lastSyncedVersion) ||
      Number(payload.invocationNum || 0) > 1 ||
      (selfInfo && (selfInfo.lineCount >= 2 || selfInfo.maxStepIndex >= 1));
    if (hasPriorHistory) {
      const syncMsg =
        `[control-tower 版本同步] 本机 control-tower 插件已更新至 v${currentVersion}。` +
        `请在本轮处理前重读最新版 control-tower 技能规范（SKILL.md、references/model-routing.md 与 references/templates.md），` +
        `同步最新模型路由、协同矩阵、缓存保护护栏、执行层精确读行纪律及账号无 Carbon 临时降档策略。`;
      injectSteps.push({ systemMessage: { systemMessage: syncMsg } });
    }
    nextCtrlEntry.lastSyncedVersion = currentVersion;
    nextCtrlEntry.updatedAt = Date.now();
    ctrlDirty = true;
  }

  if (selfInfo) {
    const comps = selfInfo.compactions || 0;
    const threshold = resolved.effective.controllerCompactionThreshold || 5;
    const lastWarned = nextCtrlEntry.lastWarnedCompactions || 0;
    if (!nextCtrlEntry.handoverIgnored && comps >= threshold && (typeof lastWarned !== 'number' || comps > lastWarned)) {
      const warn =
        `[control-tower 换届提醒] 当前现役总控会话已累计 ${comps} 次上下文自动压缩（>= ${threshold} 次阈值，非强制）。` +
        `请通过 ask_question 询问用户：选择立即换届（同步 ${regFound.absPath}、输出交接卡并可用 agentapi new-conversation 一键拉起新总控接班），` +
        `或选择「本会话忽略不再提醒」（也可在总控看板顶部一键忽略）。`;
      injectSteps.push({ systemMessage: { systemMessage: warn } });
      nextCtrlEntry.lastWarnedCompactions = comps;
      nextCtrlEntry.updatedAt = Date.now();
      ctrlDirty = true;
      upsertAttention(state, {
        id: `handover-${convId.slice(0, 8)}`,
        kind: 'handover',
        workspace: regFound.workspace,
        controllerId: convId,
        compactions: comps,
        threshold,
        summary: `总控已累计压缩 ${comps} 次（阈值 ${threshold} 次），待确认是否换届`,
        updatedAt: Date.now(),
      });
      stateDirty = true;
    }
  }

  if (ctrlDirty) {
    state.controllers[convId] = nextCtrlEntry;
    stateDirty = true;
  }

  if (stateDirty) {
    try {
      savePluginState(dataDir, state);
    } catch {
      // ignore disk errors inside hook
    }
  }

  if (injectSteps.length === 0) {
    process.stdout.write('{}\n');
    return;
  }
  process.stdout.write(`${JSON.stringify({ injectSteps })}\n`);
}

function handleStop(payload, regFound, parsedReg, resolved, dataDir, hintPath, convId) {
  if (
    resolved.plugin.stopHookReportEnabled === false ||
    payload.continuationActive === true ||
    payload.terminationReason !== 'NO_TOOL_CALL' ||
    payload.fullyIdle === false
  ) {
    process.stdout.write('{}\n');
    return;
  }

  if (isActiveController(convId, parsedReg) || !hasValidController(parsedReg)) {
    process.stdout.write('{}\n');
    return;
  }

  const workerRow = findActiveWorkerSession(convId, parsedReg);
  if (!workerRow || String(workerRow.status || '').toUpperCase() === 'DONE') {
    process.stdout.write('{}\n');
    return;
  }

  const ctrlId = String(parsedReg.controller.currentControllerId).trim();
  const selfTp = resolveSelfTranscript(payload, convId, hintPath);
  if (!selfTp) {
    process.stdout.write('{}\n');
    return;
  }

  const state = loadPluginState(dataDir);
  const prevCache = state.transcriptCache[selfTp] || null;
  const { info, nextCacheEntry } = inspectTranscript(selfTp, { cacheEntry: prevCache });
  if (nextCacheEntry && nextCacheEntry !== prevCache) {
    state.transcriptCache[selfTp] = nextCacheEntry;
  }

  const currentStep = info.maxStepIndex || info.lineCount || 0;
  const prevWorker = state.workers[convId] || {};
  if (currentStep > 0 && prevWorker.lastReportedStep >= currentStep) {
    process.stdout.write('{}\n');
    return;
  }

  if (hasOutboundAgentApiReport(selfTp, ctrlId)) {
    state.workers[convId] = {
      ...prevWorker,
      lastReportedStep: currentStep,
      pendingSilentDone: false,
      updatedAt: Date.now(),
    };
    try {
      savePluginState(dataDir, state);
    } catch {
      // ignore
    }
    process.stdout.write('{}\n');
    return;
  }

  const summary = workerRow.topic || info.goal || convId.slice(0, 8);
  state.workers[convId] = {
    ...prevWorker,
    lastReportedStep: currentStep,
    pendingSilentDone: true,
    summary,
    updatedAt: Date.now(),
  };

  const isLockedWorker =
    resolved.effective.exclusiveLeaseEnabled !== false &&
    /持|LOCKED/i.test(workerRow.lockStatus || '') &&
    !/无锁|纯离线|无独占/i.test(workerRow.lockStatus || '');

  const otherActive = (parsedReg.activeSessions || []).filter(
    (s) =>
      s.conversationId &&
      !sameControllerId(s.conversationId, convId) &&
      String(s.status || '').toUpperCase() === 'ACTIVE'
  );
  const allOthersDone = otherActive.every((s) => Boolean(state.workers[s.conversationId]?.pendingSilentDone));
  const shouldWake = Boolean(
    resolved.effective.notifyOnSingleTaskDone || isLockedWorker || allOthersDone
  );

  if (shouldWake) {
    const completedIds = [convId];
    const items = [`${convId.slice(0, 8)} (${summary}, 步数 ${currentStep})`];
    for (const s of otherActive) {
      if (state.workers[s.conversationId]?.pendingSilentDone) {
        completedIds.push(s.conversationId);
        items.push(`${s.conversationId.slice(0, 8)} (${s.topic || state.workers[s.conversationId]?.summary || '-'})`);
      }
    }
    const receipt =
      `[CT_AUTO_RECEIPT] 以下专职会话已完成当前阶段运行（Stop 自动补发回执）：` +
      `${items.join('；')}。工作区: ${regFound.workspace}。请核查尾步结果、更新台账并按需向用户输出阶段汇总。`;
    try {
      sendAgentApiMessage(ctrlId, '[CT阶段回执]', receipt);
      for (const id of completedIds) {
        if (state.workers[id]) state.workers[id].pendingSilentDone = false;
      }
    } catch {
      // keep pendingSilentDone=true if agentapi is unavailable in current environment
    }
  }

  try {
    savePluginState(dataDir, state);
  } catch {
    // ignore
  }
  process.stdout.write('{}\n');
}

function run() {
  const raw = readStdinSync();
  let payload = {};
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') payload = parsed;
    } catch {
      process.stdout.write('{}\n');
      return;
    }
  }

  const eventName = process.argv[2] || String(payload.hookEventName || '').trim();
  const convId = String(payload.conversationId || '').trim();
  const wsPaths = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [];
  const hintPath = String(payload.transcriptPath || payload.artifactDirectoryPath || '').trim();
  const dataDir = resolvePluginDataDir({ hintPath });
  const regFound = findRegistryInWorkspaces(wsPaths, { dataDir });

  if (!convId || !regFound) {
    if (eventName === 'PreToolUse') {
      process.stdout.write('{"decision":"allow"}\n');
    } else {
      process.stdout.write('{}\n');
    }
    return;
  }

  let parsedReg;
  try {
    parsedReg = parseRegistry(readFileSync(regFound.absPath, 'utf8'));
  } catch {
    if (eventName === 'PreToolUse') {
      process.stdout.write('{"decision":"allow"}\n');
    } else {
      process.stdout.write('{}\n');
    }
    return;
  }

  const resolved = resolveEffectiveSettings({
    dataDir,
    wsReal: regFound.workspace,
    pluginRoot: PLUGIN_ROOT,
  });

  if (eventName === 'PreToolUse') {
    handlePreToolUse(payload, regFound, parsedReg, resolved, convId);
    return;
  }
  if (eventName === 'SessionStart') {
    handleSessionStart(regFound, parsedReg, resolved, convId);
    return;
  }
  if (eventName === 'PreInvocation') {
    handlePreInvocation(payload, regFound, parsedReg, resolved, dataDir, hintPath, convId);
    return;
  }
  if (eventName === 'Stop') {
    handleStop(payload, regFound, parsedReg, resolved, dataDir, hintPath, convId);
    return;
  }

  process.stdout.write('{}\n');
}

run();
