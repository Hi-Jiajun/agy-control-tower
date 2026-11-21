#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  findRegistryInWorkspaces,
  resolvePluginDataDir,
} from '../lib/paths.mjs';
import {
  isActiveController,
  parseRegistry,
} from '../lib/registry.mjs';
import {
  extractPromptSessionIds,
  inspectTranscript,
  loadPluginState,
  resolveBrainTranscript,
  savePluginState,
} from '../lib/transcript.mjs';

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
  if (t.startsWith('~/')) {
    return resolve(homedir(), t.slice(2));
  }
  return resolve(t);
}

function resolveSelfTranscript(payload, convId, hintPath) {
  const tp = expandUserPath(payload.transcriptPath || '');
  if (tp && existsSync(tp)) return tp;
  const res = resolveBrainTranscript(convId, { hintPath });
  if (res.status === 'ok' && res.path) return res.path;
  return '';
}

function sameControllerId(a, b) {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || (x.length >= 8 && y.length >= 8 && (x.startsWith(y) || y.startsWith(x)));
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
  const regFound = findRegistryInWorkspaces(wsPaths);

  if (!convId || !regFound) {
    process.stdout.write('{}\n');
    return;
  }

  let parsedReg;
  try {
    parsedReg = parseRegistry(readFileSync(regFound.absPath, 'utf8'));
  } catch {
    process.stdout.write('{}\n');
    return;
  }

  if (!isActiveController(convId, parsedReg)) {
    process.stdout.write('{}\n');
    return;
  }

  if (eventName === 'SessionStart') {
    const leaseStatus = ((parsedReg.lease || {}).lockStatus || '未知').trim();
    const activeCount = (parsedReg.activeSessions || []).length;
    const msg =
      `[control-tower 总控就位] 已核验当前会话为工作区现役总控。` +
      `台账: ${regFound.absPath} | 独占锁状态: ${leaseStatus} | 活跃专职会话: ${activeCount} 个。`;
    process.stdout.write(
      `${JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: msg } }] })}\n`
    );
    return;
  }

  if (eventName !== 'PreInvocation') {
    process.stdout.write('{}\n');
    return;
  }

  const hintPath = String(payload.transcriptPath || payload.artifactDirectoryPath || '').trim();
  const dataDir = resolvePluginDataDir({ hintPath });
  const state = loadPluginState(dataDir);
  let stateDirty = false;
  const injectSteps = [];

  // 1) Bare-ID & short-command multi-ID intake
  const { ids } = extractPromptSessionIds(String(payload.lastUserInput || ''));
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

  // 2) Anti-aging handover warning when active controller has >= 2 compactions (deduped)
  const selfTp = resolveSelfTranscript(payload, convId, hintPath);
  if (selfTp) {
    const prevSelfCache = state.transcriptCache[selfTp] || null;
    const { info: selfInfo, nextCacheEntry } = inspectTranscript(selfTp, { cacheEntry: prevSelfCache });
    if (nextCacheEntry && nextCacheEntry !== prevSelfCache) {
      state.transcriptCache[selfTp] = nextCacheEntry;
      stateDirty = true;
    }
    const comps = selfInfo.compactions || 0;
    if (comps >= 2) {
      const entry = state.controllers[convId] || {};
      const lastWarned = entry.lastWarnedCompactions || 0;
      if (typeof lastWarned !== 'number' || comps > lastWarned) {
        const warn =
          `[control-tower 换届提醒] 当前现役总控会话已累计 ${comps} 次上下文自动压缩（>= 2 次阈值）。` +
          `请先将 ${regFound.absPath} 同步到最新稳态并归档本届记录，再按 control-tower 技能同目录 references/templates.md 输出不超过 25 行的《总控换届交接卡》。`;
        injectSteps.push({ systemMessage: { systemMessage: warn } });
        state.controllers[convId] = {
          lastWarnedCompactions: comps,
          updatedAt: Date.now(),
        };
        stateDirty = true;
      }
    }
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

run();
