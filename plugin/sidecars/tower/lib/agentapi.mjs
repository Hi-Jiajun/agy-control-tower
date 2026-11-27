import { execFile } from 'node:child_process';
import { resolveAgentApiSpec } from '../../../lib/paths.mjs';

const UUID_EXTRACT_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DEFAULT_META_CACHE_TTL_MS = 5000;
const MAX_META_CACHE_ENTRIES = 100;

export const ALLOWED_SLASH_PREFIXES = new Set(['', '/plan', '/boost', '/teamwork', '/goal']);

const metadataCache = new Map();
const inflightMetadata = new Map();

export function safePositionalMessage(msg) {
  const s = String(msg || '').trim();
  return s.startsWith('-') ? `\n${s}` : s;
}

/**
 * Async non-blocking agentapi CLI invocation so Sidecar never blocks the Node event loop.
 */
export function execAgentApiAsync(args, { projectId, timeoutMs = 15000 } = {}) {
  return new Promise((resolveCall, rejectCall) => {
    const env = { ...process.env };
    if (projectId) env.ANTIGRAVITY_PROJECT_ID = projectId;
    const { file, prefixArgs } = resolveAgentApiSpec({ env });
    const execArgs = [...prefixArgs, ...args];
    let settled = false;
    let killEscalationTimer = null;

    const child = execFile(
      file,
      execArgs,
      { encoding: 'utf8', env, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        settled = true;
        if (killEscalationTimer) clearTimeout(killEscalationTimer);
        if (err) {
          const msg = (stderr || err.message || 'agentapi invocation failed').trim();
          rejectCall(new Error(msg));
          return;
        }
        const trimmed = String(stdout || '').trim();
        if (!trimmed) {
          resolveCall({});
          return;
        }
        try {
          resolveCall(JSON.parse(trimmed));
        } catch {
          resolveCall({ raw: trimmed });
        }
      }
    );

    if (timeoutMs > 0) {
      killEscalationTimer = setTimeout(() => {
        if (!settled && child && !child.killed) {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, timeoutMs + 2000);
      if (typeof killEscalationTimer.unref === 'function') {
        killEscalationTimer.unref();
      }
    }
  });
}

export async function getConversationMetadataCached(
  convId,
  { projectId = '', ttlMs = DEFAULT_META_CACHE_TTL_MS } = {}
) {
  const cleanId = String(convId || '').trim();
  const cacheKey = `${String(projectId || '').trim()}::${cleanId}`;
  const now = Date.now();
  const cached = metadataCache.get(cacheKey);
  if (cached && now - cached.ts < ttlMs) {
    if (cached.data && typeof cached.data === 'object' && !Array.isArray(cached.data)) {
      return { ...cached.data, _cached: true };
    }
    return cached.data;
  }

  if (inflightMetadata.has(cacheKey)) {
    return inflightMetadata.get(cacheKey);
  }

  const p = execAgentApiAsync(['get-conversation-metadata', cleanId], { projectId })
    .then((data) => {
      metadataCache.set(cacheKey, { ts: Date.now(), data });
      if (metadataCache.size > MAX_META_CACHE_ENTRIES) {
        const oldestKey = metadataCache.keys().next().value;
        if (oldestKey) metadataCache.delete(oldestKey);
      }
      return data;
    })
    .finally(() => {
      inflightMetadata.delete(cacheKey);
    });

  inflightMetadata.set(cacheKey, p);
  return p;
}

export function invalidateMetadataCache(convId = '') {
  if (!convId) {
    metadataCache.clear();
    return;
  }
  const suffix = `::${String(convId).trim()}`;
  for (const k of metadataCache.keys()) {
    if (k.endsWith(suffix)) metadataCache.delete(k);
  }
}

export function clearMetadataCache() {
  metadataCache.clear();
  inflightMetadata.clear();
}

export function extractConversationIdFromResult(res) {
  if (!res || typeof res !== 'object') return '';
  const direct =
    res.conversationId ||
    res.conversation_id ||
    res.id ||
    res.response?.conversationId ||
    res.response?.conversation_id ||
    res.result?.conversationId;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }
  const m = JSON.stringify(res).match(UUID_EXTRACT_RE);
  return m ? m[0] : '';
}

export function buildDispatchPayload({
  prompt,
  slashPrefix = '',
  controllerId = '',
  exclusiveLeaseEnabled = true,
  lockStatus = '纯离线无锁',
  registryRelPath = '.agents/SESSION-REGISTRY.md',
}) {
  let body = String(prompt || '').trim();
  const prefix = String(slashPrefix || '').trim();
  if (prefix && !body.startsWith(prefix)) {
    body = `${prefix} ${body}`;
  }
  if (!controllerId || body.includes('[CT_REPORT:')) {
    return body;
  }
  const lockLine = exclusiveLeaseEnabled
    ? `当前资源锁约束: ${lockStatus || '纯离线无锁'}。`
    : '当前工作区处于无独占资源模式。';
  return (
    `${body}\n\n` +
    `【Control Tower 跨会话汇报锚点（现役总控: ${controllerId}）】\n` +
    `1. ${lockLine}严禁直接改写 ${registryRelPath}，亦严禁私改 AGENTS.md / .agents/rules/ / .agents/skills/。\n` +
    `2. 遇需要拍板的架构/接口/范围分叉或连续两轮假设失败时，执行：\n` +
    `   agentapi send-message "${controllerId}" "[CT_REPORT:DECISION] <分叉简述与备选方案>"\n` +
    `3. 完成收口时汇报交付摘要、验证结果及可选经验候选（无则写无）：\n` +
    `   agentapi send-message "${controllerId}" "[CT_REPORT:DONE] [<任务或分支ID>] <交付摘要与验证结论> | 【可沉淀经验候选】：<1~3行或无>"\n` +
    `4. 跨回合 edit_file 前必须先 read_file 对齐最新缩进，同一文件连续 2 次不匹配立即重读目标行段，严禁循环盲试。`
  );
}
