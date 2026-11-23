import {
  ackInboxItems,
  loadWorkspaceInbox,
  summarizeInbox,
} from '../../../lib/inbox.mjs';
import { normalizeWorkspaceInput } from '../../../lib/paths.mjs';
import { resolveEffectiveSettings } from '../../../lib/settings.mjs';
import { execAgentApiAsync } from '../lib/agentapi.mjs';

export async function handleInboxAndSwarmRoute({
  req,
  res,
  url,
  body,
  dataDir,
  pluginRoot,
  buildSnapshot,
  runSentinelSweep,
  sendJson,
  HttpError,
}) {
  if (req.method === 'GET' && url.pathname === '/api/inbox') {
    const wsRaw = url.searchParams.get('workspace') || '';
    const wsReal = wsRaw ? normalizeWorkspaceInput(wsRaw, { throwOnInvalid: true }) : '';
    const resolved = resolveEffectiveSettings({
      dataDir,
      wsReal: wsReal || '',
      pluginRoot,
      env: process.env,
    });
    const snap = wsReal ? buildSnapshot(wsReal) : null;
    const ctrlId = String(snap?.parsed?.controller?.currentControllerId || '').trim();
    const summary = summarizeInbox(wsReal ? loadWorkspaceInbox(dataDir, wsReal) : null, {
      focusCooldownSec: resolved.plugin.focusCooldownSec,
      activeControllerId: ctrlId,
    });
    sendJson(res, 200, { ok: true, inbox: summary });
    return true;
  }

  if (req.method !== 'POST') return false;

  if (url.pathname === '/api/inbox/ack') {
    const wsReal = normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true });
    if (!wsReal) throw new HttpError(400, 'workspace is required');
    ackInboxItems(dataDir, wsReal, {
      id: body.id || '',
      ackAll: Boolean(body.ackAll),
      priority: body.priority || '',
    });
    sendJson(res, 200, {
      ok: true,
      snapshot: buildSnapshot(wsReal),
    });
    return true;
  }

  if (url.pathname === '/api/inbox/deliver') {
    const wsReal = normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true });
    if (!wsReal) throw new HttpError(400, 'workspace is required');
    const snapBefore = buildSnapshot(wsReal);
    const ctrlId = String(snapBefore.parsed?.controller?.currentControllerId || '').trim();
    if (!ctrlId) throw new HttpError(400, '当前台账未登记现役总控 conversationId');
    const unread = (snapBefore.inbox?.items || []).filter((x) => !x.acked);
    const targets = body.id ? unread.filter((x) => x.id === body.id) : unread;
    if (targets.length === 0) {
      sendJson(res, 200, { ok: true, deliveredCount: 0, snapshot: snapBefore });
      return true;
    }
    const lines = targets.map((t) => `[${t.priority}] ${t.title}: ${t.summary}`);
    const msg = `[CT_INBOX_DELIVER] 用户从看板主动投递以下 ${targets.length} 条后台信箱事件，请核查处理：\n${lines.join('\n')}`;
    await execAgentApiAsync(['send-message', '--title', '[CT信箱投递]', ctrlId, msg], {
      projectId: body.projectId,
    });
    for (const t of targets) {
      ackInboxItems(dataDir, wsReal, { id: t.id });
    }
    sendJson(res, 200, {
      ok: true,
      deliveredCount: targets.length,
      snapshot: buildSnapshot(wsReal),
    });
    return true;
  }

  if (url.pathname === '/api/sentinel/sweep') {
    const wsReal = normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true });
    if (!wsReal) throw new HttpError(400, 'workspace is required');
    const sweep = runSentinelSweep(wsReal);
    sendJson(res, 200, {
      ok: true,
      detectedCount: sweep.detectedCount,
      snapshot: buildSnapshot(wsReal),
    });
    return true;
  }

  if (url.pathname === '/api/swarm/cleanup-request') {
    const wsReal = normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true });
    if (!wsReal) throw new HttpError(400, 'workspace is required');
    const snap = buildSnapshot(wsReal);
    const ctrlId = String(snap.parsed?.controller?.currentControllerId || '').trim();
    if (!ctrlId) throw new HttpError(400, '当前台账未登记现役总控 conversationId');
    const requested = Array.isArray(body.memberNames)
      ? body.memberNames.map((n) => String(n || '').trim()).filter(Boolean)
      : (snap.nativeSwarm?.members || [])
          .filter((m) => m.state === 'waiting')
          .map((m) => m.name);
    if (requested.length === 0) {
      sendJson(res, 200, { ok: true, requested: [], snapshot: snap });
      return true;
    }
    const msg =
      `[CT_SWARM_CLEANUP] 请核查以下处于 waiting 休眠态的 Swarm 成员是否已完成成果合流：${requested.join(', ')}。` +
      `确认无未落地改动后，调用 swarm(action="kill", name="...") 逐个回收以释放临时工作树。`;
    await execAgentApiAsync(['send-message', '--title', '[Swarm 回收提醒]', ctrlId, msg], {
      projectId: body.projectId,
    });
    sendJson(res, 200, { ok: true, requested, snapshot: snap });
    return true;
  }

  return false;
}
