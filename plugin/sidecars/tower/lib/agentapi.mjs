import { execFile } from 'node:child_process';

const UUID_EXTRACT_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DEFAULT_META_CACHE_TTL_MS = 5000;
const MAX_META_CACHE_ENTRIES = 100;

const metadataCache = new Map();

/**
 * Async non-blocking agentapi CLI invocation so Sidecar never blocks the Node event loop.
 */
export function execAgentApiAsync(args, { projectId, timeoutMs = 15000 } = {}) {
  return new Promise((resolveCall, rejectCall) => {
    const env = { ...process.env };
    if (projectId) env.ANTIGRAVITY_PROJECT_ID = projectId;
    const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
    const file = exe || 'agentapi';
    const execArgs = exe ? ['agentapi', ...args] : args;
    execFile(
      file,
      execArgs,
      { encoding: 'utf8', env, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
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
  });
}

export async function getConversationMetadataCached(
  convId,
  { ttlMs = DEFAULT_META_CACHE_TTL_MS } = {}
) {
  const key = String(convId || '').trim();
  const now = Date.now();
  const cached = metadataCache.get(key);
  if (cached && now - cached.ts < ttlMs) {
    return { ...cached.data, _cached: true };
  }
  const data = await execAgentApiAsync(['get-conversation-metadata', key]);
  metadataCache.set(key, { ts: now, data });
  if (metadataCache.size > MAX_META_CACHE_ENTRIES) {
    const oldestKey = metadataCache.keys().next().value;
    if (oldestKey) metadataCache.delete(oldestKey);
  }
  return data;
}

export function clearMetadataCache() {
  metadataCache.clear();
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
    `1. ${lockLine}严禁直接改写 ${registryRelPath}。\n` +
    `2. 遇需要拍板的架构/接口/范围分叉或连续两轮假设失败时，执行：\n` +
    `   agentapi send-message "${controllerId}" "[CT_REPORT:DECISION] <分叉简述与备选方案>"\n` +
    `3. 完成收口时汇报交付摘要与验证结果：\n` +
    `   agentapi send-message "${controllerId}" "[CT_REPORT:DONE] <交付摘要与验证结论>"`
  );
}
