import { existsSync, readFileSync } from 'node:fs';
import { loadWorkspaceInbox, summarizeInbox } from '../../../lib/inbox.mjs';
import { findExistingRegistry, normalizeWorkspaceInput } from '../../../lib/paths.mjs';
import { parseRegistry } from '../../../lib/registry.mjs';
import { loadWorkspaceRoadmap } from '../../../lib/roadmap.mjs';
import { resolveEffectiveSettings } from '../../../lib/settings.mjs';
import { loadPluginState } from '../../../lib/transcript.mjs';
import { isLeaseIdle } from '../ui-logic.mjs';

/**
 * Strictly read-only cross-workspace global summary across active & recent workspaces.
 * Surfaces P0/P1 attention counts, active controller IDs, lease state, and roadmap progress.
 */
export function buildMultiWorkspaceOverview({
  currentWorkspace = '',
  recentWorkspaces = [],
  dataDir = '',
  pluginRoot = '',
} = {}) {
  const candidates = [];
  const seen = new Set();
  for (const raw of [currentWorkspace, ...(Array.isArray(recentWorkspaces) ? recentWorkspaces : [])]) {
    if (!raw || typeof raw !== 'string') continue;
    const wsReal = normalizeWorkspaceInput(raw, { throwOnInvalid: false });
    if (!wsReal || !existsSync(wsReal) || seen.has(wsReal)) continue;
    seen.add(wsReal);
    candidates.push(wsReal);
    if (candidates.length >= 12) break;
  }

  const pluginState = dataDir && existsSync(dataDir) ? loadPluginState(dataDir) : { controllers: {} };
  const workspaces = [];
  let totalP0 = 0;
  let totalP1 = 0;
  let totalUnread = 0;
  let otherAttentionCount = 0;

  for (const wsReal of candidates) {
    const resolved = resolveEffectiveSettings({
      dataDir,
      wsReal,
      pluginRoot,
      env: process.env,
    });
    const found = findExistingRegistry(wsReal, {
      dataDir,
      workspaceSettings: resolved.workspace,
    });

    let ctrlId = '';
    let ctrlStatus = '';
    let leaseStatus = '未建台账';
    let leaseIdle = true;
    let activeCount = 0;
    let queueCount = 0;

    if (found && existsSync(found.absPath)) {
      try {
        const parsed = parseRegistry(readFileSync(found.absPath, 'utf8'));
        ctrlId = String(parsed.controller?.currentControllerId || '').trim();
        ctrlStatus = String(parsed.controller?.currentControllerStatus || '').trim();
        const leaseEnabled = resolved.effective.exclusiveLeaseEnabled !== false;
        leaseStatus = leaseEnabled ? String(parsed.lease?.lockStatus || 'IDLE').trim() : '无独占锁';
        leaseIdle = isLeaseIdle(leaseStatus, leaseEnabled);
        activeCount = (parsed.activeSessions || []).length;
        queueCount = (parsed.queue || []).length;
      } catch {
        leaseStatus = '解析异常';
      }
    }

    const handoverIgnored = Boolean(ctrlId && pluginState.controllers?.[ctrlId]?.handoverIgnored);
    const inboxSummary = summarizeInbox(loadWorkspaceInbox(dataDir, wsReal), {
      focusCooldownSec: resolved.plugin.focusCooldownSec,
      activeControllerId: ctrlId,
      handoverIgnored,
    });

    let roadmapDone = 0;
    let roadmapTotal = 0;
    let roadmapReady = 0;
    let roadmapExists = false;
    try {
      const rm = loadWorkspaceRoadmap(wsReal, {
        dataDir,
        workspaceSettings: resolved.workspace,
      });
      if (rm.exists && rm.graph) {
        roadmapExists = true;
        roadmapDone = rm.graph.counts?.done || 0;
        roadmapTotal = rm.graph.counts?.total || 0;
        roadmapReady = rm.graph.counts?.ready || 0;
      }
    } catch {
      roadmapExists = false;
    }

    const p0 = inboxSummary.unreadCounts?.P0 || 0;
    const p1 = inboxSummary.unreadCounts?.P1 || 0;
    const p2 = inboxSummary.unreadCounts?.P2 || 0;
    const unread = inboxSummary.unreadCounts?.total || 0;
    const isCurrent = Boolean(currentWorkspace && wsReal === currentWorkspace);

    totalP0 += p0;
    totalP1 += p1;
    totalUnread += unread;
    if (!isCurrent && (p0 > 0 || p1 > 0)) {
      otherAttentionCount += p0 + p1;
    }

    const shortName = wsReal.split('/').filter(Boolean).slice(-2).join('/') || wsReal;
    workspaces.push({
      workspace: wsReal,
      shortName,
      isCurrent,
      registryExists: Boolean(found),
      registryIsManaged: Boolean(found?.isManaged),
      controllerId: ctrlId,
      controllerStatus: ctrlStatus,
      leaseStatus,
      leaseIdle,
      activeSessionCount: activeCount,
      queueCount,
      focusMode: inboxSummary.focus?.mode || 'idle',
      unreadCounts: { P0: p0, P1: p1, P2: p2, total: unread },
      roadmapExists,
      roadmapDone,
      roadmapTotal,
      roadmapReady,
    });
  }

  return {
    workspaceCount: workspaces.length,
    totalP0,
    totalP1,
    totalUnread,
    otherAttentionCount,
    workspaces,
  };
}

export function handleWorkspacesRoute({
  req,
  res,
  url,
  dataDir,
  pluginRoot,
  loadRecentWorkspaces,
  sendJson,
}) {
  if (req.method === 'GET' && url.pathname === '/api/workspaces/overview') {
    const currentRaw = url.searchParams.get('workspace') || '';
    const currentWs = currentRaw ? normalizeWorkspaceInput(currentRaw, { throwOnInvalid: false }) || '' : '';
    const overview = buildMultiWorkspaceOverview({
      currentWorkspace: currentWs,
      recentWorkspaces: loadRecentWorkspaces(),
      dataDir,
      pluginRoot,
    });
    sendJson(res, 200, { ok: true, multiWorkspace: overview });
    return true;
  }
  return false;
}
