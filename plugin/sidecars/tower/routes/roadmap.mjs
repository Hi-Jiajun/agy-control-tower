import { normalizeWorkspaceInput } from '../../../lib/paths.mjs';
import {
  buildWorkstreamContractPrompt,
  deleteRoadmapNode,
  initWorkspaceRoadmap,
  loadWorkspaceRoadmap,
  saveRoadmapL1,
  updateRoadmapNodeStatus,
  upsertRoadmapMilestone,
  upsertRoadmapNode,
} from '../../../lib/roadmap.mjs';
import { resolveEffectiveSettings } from '../../../lib/settings.mjs';
import { execAgentApiAsync } from '../lib/agentapi.mjs';

export async function handleRoadmapRoute({
  req,
  res,
  url,
  body,
  dataDir,
  pluginRoot,
  buildSnapshot,
  sendJson,
  HttpError,
}) {
  if (req.method === 'GET' && url.pathname === '/api/roadmap') {
    const wsRaw = url.searchParams.get('workspace') || '';
    const wsReal = wsRaw ? normalizeWorkspaceInput(wsRaw, { throwOnInvalid: true }) : '';
    const resolved = resolveEffectiveSettings({
      dataDir,
      wsReal: wsReal || '',
      pluginRoot,
      env: process.env,
    });
    const roadmap = wsReal
      ? loadWorkspaceRoadmap(wsReal, { dataDir, workspaceSettings: resolved.workspace })
      : { exists: false };
    sendJson(res, 200, { ok: true, roadmap });
    return true;
  }

  if (req.method !== 'POST') return false;

  if (url.pathname === '/api/roadmap/init') {
    const wsReal = normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true });
    if (!wsReal) throw new HttpError(400, 'workspace is required');
    const storageMode = body.storageMode === 'plugin_data' ? 'plugin_data' : 'workspace';
    initWorkspaceRoadmap(wsReal, {
      dataDir,
      storageMode,
      projectName: body.projectName || '',
    });
    sendJson(res, 200, { ok: true, snapshot: buildSnapshot(wsReal) });
    return true;
  }

  if (url.pathname === '/api/roadmap/l1/save') {
    const wsReal = normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true });
    if (!wsReal) throw new HttpError(400, 'workspace is required');
    const resolved = resolveEffectiveSettings({ dataDir, wsReal, pluginRoot, env: process.env });
    saveRoadmapL1(wsReal, body.content, { dataDir, workspaceSettings: resolved.workspace });
    sendJson(res, 200, { ok: true, snapshot: buildSnapshot(wsReal) });
    return true;
  }

  if (url.pathname === '/api/roadmap/milestone/upsert') {
    const wsReal = normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true });
    if (!wsReal) throw new HttpError(400, 'workspace is required');
    const resolved = resolveEffectiveSettings({ dataDir, wsReal, pluginRoot, env: process.env });
    upsertRoadmapMilestone(wsReal, body, { dataDir, workspaceSettings: resolved.workspace });
    sendJson(res, 200, { ok: true, snapshot: buildSnapshot(wsReal) });
    return true;
  }

  if (url.pathname === '/api/roadmap/node/upsert') {
    const wsReal = normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true });
    if (!wsReal) throw new HttpError(400, 'workspace is required');
    const resolved = resolveEffectiveSettings({ dataDir, wsReal, pluginRoot, env: process.env });
    upsertRoadmapNode(wsReal, body, { dataDir, workspaceSettings: resolved.workspace });
    sendJson(res, 200, { ok: true, snapshot: buildSnapshot(wsReal) });
    return true;
  }

  if (url.pathname === '/api/roadmap/node/status') {
    const wsReal = normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true });
    if (!wsReal) throw new HttpError(400, 'workspace is required');
    const resolved = resolveEffectiveSettings({ dataDir, wsReal, pluginRoot, env: process.env });
    const { newlyUnlocked } = updateRoadmapNodeStatus(
      wsReal,
      { id: body.id, status: body.status, linkedConvId: body.linkedConvId },
      { dataDir, workspaceSettings: resolved.workspace }
    );
    sendJson(res, 200, {
      ok: true,
      newlyUnlocked,
      snapshot: buildSnapshot(wsReal),
    });
    return true;
  }

  if (url.pathname === '/api/roadmap/node/delete') {
    const wsReal = normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true });
    if (!wsReal) throw new HttpError(400, 'workspace is required');
    const resolved = resolveEffectiveSettings({ dataDir, wsReal, pluginRoot, env: process.env });
    deleteRoadmapNode(wsReal, body.id, { dataDir, workspaceSettings: resolved.workspace });
    sendJson(res, 200, { ok: true, snapshot: buildSnapshot(wsReal) });
    return true;
  }

  if (url.pathname === '/api/roadmap/node/contract') {
    const wsReal = normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true });
    if (!wsReal) throw new HttpError(400, 'workspace is required');
    const snap = buildSnapshot(wsReal);
    if (!snap.roadmap?.exists) throw new HttpError(404, 'Roadmap not initialized in workspace');
    const node = (snap.roadmap.graph?.nodes || []).find((n) => n.id === body.id);
    if (!node) throw new HttpError(404, `Workstream node ${body.id} not found`);
    const overlaps = (snap.roadmap.graph?.overlaps || []).filter(
      (o) => o.nodeA === node.id || o.nodeB === node.id
    );
    const contractPrompt = buildWorkstreamContractPrompt(node, {
      controllerId: snap.parsed?.controller?.currentControllerId || '',
      exclusiveLeaseEnabled: snap.settings?.effective?.exclusiveLeaseEnabled !== false,
      registryRelPath: snap.registryRelPath || '.agents/SESSION-REGISTRY.md',
      northStarBrief: snap.roadmap.northStarBrief || '',
      overlaps,
    });
    sendJson(res, 200, { ok: true, node, contractPrompt });
    return true;
  }

  if (url.pathname === '/api/roadmap/node/dispatch-hidden') {
    const wsReal = normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true });
    if (!wsReal) throw new HttpError(400, 'workspace is required');
    const snap = buildSnapshot(wsReal);
    if (!snap.roadmap?.exists) throw new HttpError(404, 'Roadmap not initialized in workspace');
    const ctrlId = String(snap.parsed?.controller?.currentControllerId || '').trim();
    if (!ctrlId) throw new HttpError(400, '当前台账未登记现役总控 conversationId，请先登记总控');
    const node = (snap.roadmap.graph?.nodes || []).find((n) => n.id === body.id);
    if (!node) throw new HttpError(404, `Workstream node ${body.id} not found`);

    const overlaps = (snap.roadmap.graph?.overlaps || []).filter(
      (o) => o.nodeA === node.id || o.nodeB === node.id
    );
    const contractPrompt = buildWorkstreamContractPrompt(node, {
      controllerId: ctrlId,
      exclusiveLeaseEnabled: snap.settings?.effective?.exclusiveLeaseEnabled !== false,
      registryRelPath: snap.registryRelPath || '.agents/SESSION-REGISTRY.md',
      northStarBrief: snap.roadmap.northStarBrief || '',
      overlaps,
    });
    const dispatchMsg =
      `[CT_ROADMAP_DISPATCH] 请按「隐藏面优先」原则（优先原生 swarm 成员或 invoke_subagent，隔离档位 workspace="${node.isolation || 'share'}"，建议模型 ${node.recommendedModel || 'Gemini 4 Neon (High)'}）为以下路线图分支派单并推进（零左侧栏污染）：\n\n` +
      contractPrompt;
    await execAgentApiAsync(['send-message', '--title', `[路线图派单 ${node.id}]`, ctrlId, dispatchMsg], {
      projectId: body.projectId,
    });

    const resolved = resolveEffectiveSettings({ dataDir, wsReal, pluginRoot, env: process.env });
    updateRoadmapNodeStatus(
      wsReal,
      { id: node.id, status: 'active' },
      { dataDir, workspaceSettings: resolved.workspace }
    );
    sendJson(res, 200, {
      ok: true,
      nodeId: node.id,
      controllerId: ctrlId,
      snapshot: buildSnapshot(wsReal),
    });
    return true;
  }

  return false;
}
