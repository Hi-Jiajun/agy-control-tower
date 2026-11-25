import {
  computeLivePollPlan,
  computeTabVisibility,
  escHtml as esc,
  nextInlineConfirmState,
} from './ui-logic.mjs';
import {
  bindOverviewEvents,
  renderAttentionBanner,
  renderGlobalWorkspacesDrawer,
  renderOverview,
  spawnHandoverController,
} from './views/overview.mjs';
import {
  bindRoadmapEvents,
  renderRoadmap,
} from './views/roadmap.mjs';
import {
  bindSessionsAndQueueEvents,
  openInlineArchiveForm,
  renderQueue,
  renderRaw,
  renderSessions,
} from './views/sessions.mjs';
import {
  bindSettingsEvents,
  loadDiagnostics,
  renderSettings,
} from './views/settings.mjs';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const uiToken = params.get('token') || '';

const state = {
  tab: 'overview',
  settingsScope: 'plugin',
  workspace: '',
  snap: null,
  toastTimer: null,
  pollTimer: null,
  pollInFlight: false,
  pollPausedByUser: false,
  sse: null,
  sseConnected: false,
  sseWorkspace: '',
  sseRefreshTimer: null,
  rawDirty: false,
  rawBaseHash: '',
  rmL1Dirty: false,
  rmL1BaseHash: '',
  globalDocDirty: false,
  wsDocDirty: false,
  settingsDirty: {
    plugin: false,
    global: false,
    workspace: false,
  },
  refreshSeq: 0,
  diagSeq: 0,
  probeSeq: 0,
  lastProbe: null,
  diagLoaded: false,
};

function syncTheme() {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #0f172a)';
  (document.body || document.documentElement).appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  const nums = (c.match(/[\d.]+/g) || []).map(Number);
  if (nums.length >= 3) {
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }
}
syncTheme();
new MutationObserver(syncTheme).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['style'],
});

function showToast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = isErr ? 'toast error' : 'toast';
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}

const confirmTimers = new WeakMap();

function disarmInlineConfirm(btn) {
  if (!btn) return;
  const prevTimer = confirmTimers.get(btn);
  if (prevTimer) {
    clearTimeout(prevTimer);
    confirmTimers.delete(btn);
  }
  if (btn.dataset.origText) {
    btn.textContent = btn.dataset.origText;
  }
  delete btn.dataset.confirmArmed;
  delete btn.dataset.confirmExpiresAt;
  btn.classList.remove('btn-confirm-armed');
}

async function confirmInline(btn, confirmLabel, asyncFn, timeoutMs = 3000) {
  if (!btn) return asyncFn();
  if (!btn.dataset.origText) {
    btn.dataset.origText = btn.textContent || '';
  }
  const decision = nextInlineConfirmState({
    armed: btn.dataset.confirmArmed === '1',
    nowMs: Date.now(),
    expiresAt: Number(btn.dataset.confirmExpiresAt || 0),
    defaultLabel: btn.dataset.origText,
    confirmLabel,
    timeoutMs,
  });

  if (!decision.execute) {
    btn.dataset.confirmArmed = '1';
    btn.dataset.confirmExpiresAt = String(decision.nextExpiresAt);
    btn.textContent = decision.label;
    btn.classList.add('btn-confirm-armed');
    const prevTimer = confirmTimers.get(btn);
    if (prevTimer) clearTimeout(prevTimer);
    const t = setTimeout(() => disarmInlineConfirm(btn), timeoutMs);
    confirmTimers.set(btn, t);
    return;
  }

  disarmInlineConfirm(btn);
  return await withBusyButton(btn, asyncFn);
}

async function withBusyButton(btn, asyncFn) {
  if (btn && btn.disabled) return;
  if (btn) btn.disabled = true;
  try {
    return await asyncFn();
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (uiToken) headers['x-sidecar-token'] = uiToken;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const fetchFn = window.sidecar?.fetch || fetch;
  const res = await fetchFn(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 409) {
      $('conflict-banner')?.classList.remove('hidden');
    }
    const err = new Error(data.message || data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function sendToActiveController(message) {
  const ctrlId = state.snap?.parsed?.controller?.currentControllerId;
  if (!ctrlId) {
    throw new Error('当前台账未登记现役总控 conversationId');
  }
  if (window.sidecar?.agent?.sendMessage) {
    return await window.sidecar.agent.sendMessage(message, ctrlId);
  }
  return await api('/_sidecar/send-message', {
    method: 'POST',
    body: { conversationId: ctrlId, message },
  });
}

function applyMotionSetting(snap) {
  const motion = snap?.settings?.plugin?.uiMotion || 'standard';
  document.documentElement.dataset.motion = motion;
}

function renderWorkspaces(snap) {
  const sel = $('ws-select');
  const items = Array.isArray(snap.recentWorkspaces) ? snap.recentWorkspaces : [];
  const list = snap.workspace && !items.includes(snap.workspace) ? [snap.workspace, ...items] : items;
  if (list.length === 0) {
    sel.innerHTML = '<option value="">当前未绑定工作区</option>';
  } else {
    sel.innerHTML = list
      .map((ws) => {
        const shortName = ws.split('/').filter(Boolean).slice(-2).join('/') || ws;
        return `<option value="${esc(ws)}" ${ws === snap.workspace ? 'selected' : ''}>${esc(shortName)} (${esc(ws)})</option>`;
      })
      .join('');
  }
  const relBadge = $('reg-rel-badge');
  if (snap.registryExists && snap.registryRelPath) {
    relBadge.textContent = snap.registryIsManaged ? '零侵入托管台账' : snap.registryRelPath;
    relBadge.className = `badge ${snap.registryIsManaged ? '' : 'badge-muted'}`;
    relBadge.classList.remove('hidden');
  } else {
    relBadge.classList.add('hidden');
  }
}

function resetTransientForms() {
  state.rawDirty = false;
  state.rawBaseHash = '';
  state.rmL1Dirty = false;
  state.rmL1BaseHash = '';
  state.globalDocDirty = false;
  state.wsDocDirty = false;
  state.settingsDirty = { plugin: false, global: false, workspace: false };
  state.lastProbe = null;
  $('df-workstreamId').value = '';
  $('df-workstream-note').classList.add('hidden');
  delete $('df-model').dataset.userEdited;
  delete $('qf-route').dataset.userEdited;
  $('rnf-originalId').value = '';
  $('qf-originalId').value = '';
  $('af-convId').value = '';
  $('probe-result').classList.add('hidden');
  ['lease-form', 'ctrl-form', 'session-form', 'archive-form', 'rm-node-form', 'rm-ms-form'].forEach((id) => {
    $(id)?.classList.add('hidden');
  });
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((btn) => {
    const isAct = btn.dataset.tab === tab;
    btn.classList.toggle('active', isAct);
    btn.setAttribute('aria-selected', isAct ? 'true' : 'false');
  });
  const vis = computeTabVisibility({
    tab,
    hasReg: Boolean(state.snap?.registryExists),
    hasWorkspace: Boolean(state.snap?.workspace),
  });
  $('empty-state').classList.toggle('hidden', !vis.showEmpty);
  Object.entries(vis.visibleTabs).forEach(([name, visible]) => {
    $(`tab-${name}`).classList.toggle('hidden', !visible);
  });
  if (tab === 'settings' && state.settingsScope === 'plugin') {
    loadDiagnostics(ctx, { silent: true });
  }
}

function switchSettingsScope(scope) {
  state.settingsScope = scope;
  document.querySelectorAll('.seg-btn').forEach((btn) => {
    const isAct = btn.dataset.scope === scope;
    btn.classList.toggle('active', isAct);
    btn.setAttribute('aria-selected', isAct ? 'true' : 'false');
  });
  ['plugin', 'global', 'workspace'].forEach((name) => {
    $(`settings-scope-${name}`).classList.toggle('hidden', name !== scope);
  });
  if (scope === 'plugin') {
    loadDiagnostics(ctx, { silent: true });
  }
}

function isUiBusyEditing() {
  const activeTag = document.activeElement?.tagName;
  if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return true;
  if (document.querySelector('.btn-confirm-armed')) return true;
  if (
    state.rawDirty ||
    state.rmL1Dirty ||
    state.globalDocDirty ||
    state.wsDocDirty ||
    state.settingsDirty.plugin ||
    state.settingsDirty.global ||
    state.settingsDirty.workspace
  ) {
    return true;
  }
  return (
    !$('lease-form').classList.contains('hidden') ||
    !$('ctrl-form').classList.contains('hidden') ||
    !$('session-form').classList.contains('hidden') ||
    !$('archive-form').classList.contains('hidden') ||
    !$('dispatch-form').classList.contains('hidden') ||
    !$('rm-l1-wrap').classList.contains('hidden') ||
    !$('rm-node-form').classList.contains('hidden') ||
    !$('rm-ms-form').classList.contains('hidden')
  );
}

function connectSseStream(wsTarget = state.workspace) {
  if (typeof EventSource !== 'function' || !location.protocol.startsWith('http')) return;
  if (state.pollPausedByUser || state.snap?.settings?.plugin?.livePollEnabled === false) {
    if (state.sse) {
      state.sse.close();
      state.sse = null;
      state.sseConnected = false;
    }
    return;
  }
  if (state.sse && state.sseWorkspace === wsTarget) return;

  if (state.sse) {
    state.sse.close();
    state.sse = null;
    state.sseConnected = false;
  }

  const sp = new URLSearchParams();
  if (uiToken) sp.set('token', uiToken);
  if (wsTarget) sp.set('workspace', wsTarget);
  const qs = sp.toString();
  const es = new EventSource(`/api/events${qs ? `?${qs}` : ''}`);
  state.sse = es;
  state.sseWorkspace = wsTarget;

  es.addEventListener('connected', () => {
    state.sseConnected = true;
    if (state.snap) updateLivePollControls(state.snap);
  });

  es.addEventListener('workspace_changed', () => {
    if (state.pollPausedByUser || document.visibilityState !== 'visible') return;
    if (state.sseRefreshTimer) clearTimeout(state.sseRefreshTimer);
    state.sseRefreshTimer = setTimeout(() => {
      state.sseRefreshTimer = null;
      if (state.pollInFlight || isUiBusyEditing()) return;
      refresh(undefined, { silent: true });
    }, 90);
  });

  es.onerror = () => {
    if (state.sseConnected) {
      state.sseConnected = false;
      if (state.snap) updateLivePollControls(state.snap);
    }
  };
}

window.addEventListener('beforeunload', () => {
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
});

function updateLivePollControls(snap) {
  connectSseStream(snap?.workspace || state.workspace);
  const plan = computeLivePollPlan({
    pluginPollEnabled: snap?.settings?.plugin?.livePollEnabled !== false,
    pausedByUser: state.pollPausedByUser,
    intervalSec: Number(snap?.settings?.plugin?.livePollIntervalSec || 4),
    activeSessionCount: (snap?.parsed?.activeSessions || []).length,
    swarmActive: Boolean(snap?.nativeSwarm?.active),
    sseConnected: state.sseConnected,
  });
  $('live-dot').classList.toggle('live', plan.dotLive);
  const btn = $('poll-toggle-btn');
  btn.classList.toggle('active', plan.isLive);
  btn.textContent = plan.buttonText;

  clearInterval(state.pollTimer);
  state.pollTimer = null;
  if (plan.shouldSchedule) {
    state.pollTimer = setInterval(() => {
      if (state.pollInFlight || document.visibilityState !== 'visible') return;
      if (isUiBusyEditing()) return;
      refresh(undefined, { silent: true });
    }, plan.intervalMs);
  }
}

function render(snap) {
  if (!snap) return;
  if (snap.workspace && state.workspace && snap.workspace !== state.workspace) {
    return;
  }
  if (snap.workspace) {
    state.workspace = snap.workspace;
  }
  state.snap = snap;
  $('version-badge').textContent = `v${snap.plugin?.version || '1.7.0'}`;
  applyMotionSetting(snap);
  renderWorkspaces(snap);
  renderGlobalWorkspacesDrawer(ctx, snap);
  renderAttentionBanner(ctx, snap);

  const hasReg = Boolean(snap.registryExists);
  $('empty-ws-path').textContent = snap.workspace ? `当前工作区: ${snap.workspace}` : '';
  switchTab(state.tab);
  renderSettings(ctx, snap);
  renderRoadmap(ctx, snap);

  if (hasReg) {
    renderOverview(ctx, snap);
    renderSessions(ctx, snap);
    renderQueue(ctx, snap);
    renderRaw(ctx, snap);
  }
  updateLivePollControls(snap);
}

async function refresh(wsOverride, { recordSelection = false, silent = false } = {}) {
  const targetWs = wsOverride !== undefined ? wsOverride : state.workspace;
  if (wsOverride !== undefined && wsOverride !== state.workspace) {
    resetTransientForms();
    state.workspace = wsOverride;
  }
  const seq = ++state.refreshSeq;
  state.pollInFlight = true;
  try {
    let snap;
    if (recordSelection && targetWs) {
      const res = await api('/api/workspace/select', {
        method: 'POST',
        body: { workspace: targetWs },
      });
      snap = res.snapshot;
    } else {
      const qs = targetWs ? `?workspace=${encodeURIComponent(targetWs)}` : '';
      snap = await api(`/api/snapshot${qs}`);
    }
    if (seq !== state.refreshSeq) return;
    state.workspace = snap.workspace || '';
    if (!silent) {
      state.rawDirty = false;
      state.rmL1Dirty = false;
      state.globalDocDirty = false;
      state.wsDocDirty = false;
      state.settingsDirty = { plugin: false, global: false, workspace: false };
      $('conflict-banner').classList.add('hidden');
    }
    render(snap);
  } catch (err) {
    if (!silent && seq === state.refreshSeq) showToast(err.message, true);
  } finally {
    if (seq === state.refreshSeq) {
      state.pollInFlight = false;
    }
  }
}

const ctx = {
  $,
  state,
  api,
  render,
  refresh,
  showToast,
  withBusyButton,
  confirmInline,
  copyText,
  sendToActiveController,
  switchTab,
  switchSettingsScope,
};

function bindArrowTabNav(selector, activateBtn) {
  const container = document.querySelector(selector);
  if (!container) return;
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const btns = [...container.querySelectorAll('button[role="tab"]')];
    const idx = btns.indexOf(document.activeElement);
    if (idx < 0) return;
    e.preventDefault();
    const nextIdx = e.key === 'ArrowRight' ? (idx + 1) % btns.length : (idx - 1 + btns.length) % btns.length;
    btns[nextIdx].focus();
    activateBtn(btns[nextIdx]);
  });
}

// Navigation & Topbar
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});
document.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchSettingsScope(btn.dataset.scope));
});
bindArrowTabNav('.tabs', (btn) => switchTab(btn.dataset.tab));
bindArrowTabNav('.segmented', (btn) => switchSettingsScope(btn.dataset.scope));
$('poll-toggle-btn').addEventListener('click', () => {
  state.pollPausedByUser = !state.pollPausedByUser;
  if (state.snap) updateLivePollControls(state.snap);
});
$('refresh-btn').addEventListener('click', () => refresh());
$('ws-select').addEventListener('change', (e) => {
  if (e.target.value) refresh(e.target.value, { recordSelection: true });
});
$('global-ws-btn').addEventListener('click', () => {
  $('global-ws-drawer').classList.toggle('hidden');
});
$('close-global-ws-btn').addEventListener('click', () => {
  $('global-ws-drawer').classList.add('hidden');
});

// Empty-state registry initialization
$('init-relpath').addEventListener('change', (e) => {
  $('init-custom-wrap').classList.toggle('hidden', e.target.value !== '__custom__');
});
$('init-registry-btn').addEventListener('click', async () => {
  if (!state.workspace) return;
  let relPath = $('init-relpath').value;
  if (relPath === '__custom__') {
    relPath = $('init-custom-relpath').value.trim();
    if (!relPath) return showToast('请输入自定义相对路径', true);
  }
  try {
    const res = await api('/api/registry/init', {
      method: 'POST',
      body: { workspace: state.workspace, relPath },
    });
    render(res.snapshot);
    showToast('已初始化 SESSION-REGISTRY.md');
  } catch (err) {
    showToast(err.message, true);
  }
});
$('copy-bootstrap-empty-btn').addEventListener('click', async () => {
  const ok = await copyText(state.snap?.templates?.bootstrapPrompt || '');
  showToast(ok ? '已复制冷启动引导词' : '复制失败', !ok);
});
$('open-settings-empty-btn').addEventListener('click', () => switchTab('settings'));

// Bind modular view listeners
bindOverviewEvents(ctx);
bindSessionsAndQueueEvents(ctx);
bindRoadmapEvents(ctx);
bindSettingsEvents(ctx);

// Delegated interactive actions across dynamic cards
document.body.addEventListener('click', async (e) => {
  const inbDeliver = e.target.closest('.inbox-deliver-btn');
  if (inbDeliver?.dataset.id && state.workspace) {
    await withBusyButton(inbDeliver, async () => {
      try {
        const res = await api('/api/inbox/deliver', {
          method: 'POST',
          body: { workspace: state.workspace, id: inbDeliver.dataset.id },
        });
        render(res.snapshot);
        showToast('已将事件投递给现役总控');
      } catch (err) {
        showToast(err.message, true);
      }
    });
    return;
  }

  const inbAck = e.target.closest('.inbox-ack-btn');
  if (inbAck?.dataset.id && state.workspace) {
    try {
      const res = await api('/api/inbox/ack', {
        method: 'POST',
        body: { workspace: state.workspace, id: inbAck.dataset.id },
      });
      render(res.snapshot);
    } catch (err) {
      showToast(err.message, true);
    }
    return;
  }

  const rmDispatchHidden = e.target.closest('.rm-dispatch-hidden-btn');
  if (rmDispatchHidden?.dataset.id && state.workspace && !rmDispatchHidden.disabled) {
    await withBusyButton(rmDispatchHidden, async () => {
      try {
        const res = await api('/api/roadmap/node/dispatch-hidden', {
          method: 'POST',
          body: {
            workspace: state.workspace,
            id: rmDispatchHidden.dataset.id,
            expectedL2Hash: state.snap?.roadmap?.l2Hash || '',
          },
        });
        render(res.snapshot);
        showToast(`已将分支 ${rmDispatchHidden.dataset.id} 契约投递总控按隐藏面派单`);
      } catch (err) {
        showToast(err.message, true);
      }
    });
    return;
  }

  const rmFill = e.target.closest('.rm-fill-dispatch-btn');
  if (rmFill?.dataset.id && state.workspace) {
    try {
      const res = await api('/api/roadmap/node/contract', {
        method: 'POST',
        body: { workspace: state.workspace, id: rmFill.dataset.id },
      });
      const node = res.node || {};
      switchTab('sessions');
      $('dispatch-form').classList.remove('hidden');
      $('df-workstreamId').value = node.id || rmFill.dataset.id;
      $('df-workstream-text').textContent = `已关联路线图分支: ${node.id || rmFill.dataset.id} (${node.title || ''})，拉起后自动回链`;
      $('df-workstream-note').classList.remove('hidden');
      $('df-topic').value = `${node.id} ${node.title || ''}`.trim();
      if (node.recommendedModel) {
        $('df-model').value = node.recommendedModel;
        $('df-model').dataset.userEdited = '1';
      }
      $('df-prompt').value = res.contractPrompt || '';
      showToast(`已填入白名单直派表单并关联 ${node.id}`);
    } catch (err) {
      showToast(err.message, true);
    }
    return;
  }

  const rmCopy = e.target.closest('.rm-copy-contract-btn');
  if (rmCopy?.dataset.id && state.workspace) {
    try {
      const res = await api('/api/roadmap/node/contract', {
        method: 'POST',
        body: { workspace: state.workspace, id: rmCopy.dataset.id },
      });
      const ok = await copyText(res.contractPrompt || '');
      showToast(ok ? `已复制 ${rmCopy.dataset.id} 四象限契约派单词` : '复制失败', !ok);
    } catch (err) {
      showToast(err.message, true);
    }
    return;
  }

  const rmDone = e.target.closest('.rm-mark-done-btn');
  if (rmDone?.dataset.id && state.workspace) {
    try {
      const res = await api('/api/roadmap/node/status', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          id: rmDone.dataset.id,
          status: 'done',
          expectedL2Hash: state.snap?.roadmap?.l2Hash || '',
        },
      });
      render(res.snapshot);
      const unlocked = Array.isArray(res.newlyUnlocked) ? res.newlyUnlocked : [];
      showToast(
        unlocked.length > 0
          ? `${rmDone.dataset.id} 已完成，新解锁可并行分支: ${unlocked.map((u) => u.id).join(', ')}`
          : `${rmDone.dataset.id} 已标记完成`
      );
    } catch (err) {
      showToast(err.message, true);
    }
    return;
  }

  const rmEdit = e.target.closest('.rm-edit-node-btn');
  if (rmEdit?.dataset.id) {
    const node = (state.snap?.roadmap?.graph?.nodes || []).find((n) => n.id === rmEdit.dataset.id);
    if (node) {
      $('rnf-originalId').value = node.id;
      $('rnf-id').value = node.id;
      $('rnf-milestoneId').value = node.milestoneId || 'M1';
      $('rnf-title').value = node.title || '';
      $('rnf-epic').value = node.epic || 'Core';
      $('rnf-status').value = node.status || 'planned';
      $('rnf-isolation').value = node.isolation || 'share';
      $('rnf-collaboration').value = node.collaboration || 'swarm_channel';
      $('rnf-dependsOn').value = (node.dependsOn || []).join(', ');
      $('rnf-ownership').value = (node.ownership || []).join(', ');
      $('rnf-model').value = node.recommendedModel || 'Gemini 4 Neon (High)';
      $('rnf-acceptance').value = node.acceptance || '';
      $('rm-node-form').classList.remove('hidden');
    }
    return;
  }

  const rmDel = e.target.closest('.rm-del-node-btn');
  if (rmDel?.dataset.id && state.workspace) {
    const nodeId = rmDel.dataset.id;
    await confirmInline(rmDel, '确认删除?', async () => {
      try {
        const res = await api('/api/roadmap/node/delete', {
          method: 'POST',
          body: {
            workspace: state.workspace,
            id: nodeId,
            expectedL2Hash: state.snap?.roadmap?.l2Hash || '',
          },
        });
        render(res.snapshot);
        showToast(`已删除分支节点 ${nodeId}`);
      } catch (err) {
        showToast(err.message, true);
      }
    });
    return;
  }

  const switchWsCard = e.target.closest('.switch-ws-card-btn');
  if (switchWsCard?.dataset.ws) {
    $('global-ws-drawer').classList.add('hidden');
    await refresh(switchWsCard.dataset.ws, { recordSelection: true });
    return;
  }

  const gotoWs = e.target.closest('.goto-ws-settings-btn');
  if (gotoWs) {
    switchTab('settings');
    switchSettingsScope('workspace');
    return;
  }

  const clearOv = e.target.closest('.ws-clear-ov');
  if (clearOv?.dataset.key && state.workspace) {
    try {
      const res = await api('/api/settings/workspace', {
        method: 'POST',
        body: { workspace: state.workspace, overrides: { [clearOv.dataset.key]: null } },
      });
      render(res.snapshot);
      showToast('已恢复继承全局设置');
    } catch (err) {
      showToast(err.message, true);
    }
    return;
  }

  const spawnHandover = e.target.closest('.spawn-handover-btn');
  if (spawnHandover) {
    await withBusyButton(spawnHandover, () =>
      spawnHandoverController(ctx, spawnHandover.dataset.id || '')
    );
    return;
  }

  const dismissAtt = e.target.closest('.dismiss-att-btn');
  if (dismissAtt) {
    try {
      const res = await api('/api/attention/dismiss', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          kind: dismissAtt.dataset.kind || undefined,
          controllerId: dismissAtt.dataset.ctrl || undefined,
          id: dismissAtt.dataset.id || undefined,
        },
      });
      render(res.snapshot);
    } catch (err) {
      showToast(err.message, true);
    }
    return;
  }

  const enrollBtn = e.target.closest('.enroll-probe-btn');
  if (enrollBtn && state.lastProbe?.status === 'ok') {
    const p = state.lastProbe;
    const info = p.info || {};
    const leaseOff = state.snap?.settings?.effective?.exclusiveLeaseEnabled === false;
    try {
      const res = await api('/api/sessions/upsert', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          relPath: state.snap.registryRelPath,
          expectedHash: state.snap.hash,
          conversationId: p.conversationId,
          topic: info.goal || '专职会话',
          modelTool: info.lastModel || '-',
          lockStatus: leaseOff ? '无独占资源限制' : '纯离线无锁',
          status: info.lastStatus === 'DONE' ? 'DONE' : 'ACTIVE',
          paths: '-',
        },
      });
      render(res.snapshot);
      showToast(`已入账会话 ${p.conversationId.slice(0, 8)}`);
    } catch (err) {
      showToast(err.message, true);
    }
    return;
  }

  const notifyBtn = e.target.closest('.notify-ctrl-btn');
  if (notifyBtn?.dataset.id) {
    await withBusyButton(notifyBtn, async () => {
      try {
        await sendToActiveController(notifyBtn.dataset.id);
        showToast(`已向现役总控投递 ${notifyBtn.dataset.id.slice(0, 8)}`);
      } catch (err) {
        showToast(err.message, true);
      }
    });
    return;
  }

  const learnBtn = e.target.closest('.send-learn-btn');
  if (learnBtn?.dataset.id) {
    await withBusyButton(learnBtn, async () => {
      try {
        await api('/_sidecar/send-message', {
          method: 'POST',
          body: {
            conversationId: learnBtn.dataset.id,
            title: '[CT学习沉淀]',
            message:
              '/learn 请结合本会话近期用户纠偏、排障根因与阶段经验候选，按原生 /learn 规范产出精简 learning_proposal.md 提案供我审批；如无新可复用经验请直接说明无需变更。',
          },
        });
        showToast(`已向会话 ${learnBtn.dataset.id.slice(0, 8)} 发送 /learn`);
      } catch (err) {
        showToast(err.message, true);
      }
    });
    return;
  }

  const archiveBtn = e.target.closest('.archive-conv-btn');
  if (archiveBtn?.dataset.id) {
    openInlineArchiveForm(ctx, archiveBtn.dataset.id, archiveBtn.dataset.topic || '');
    return;
  }

  const jump = e.target.closest('.jump-conv-btn');
  if (jump?.dataset.id) {
    window.sidecar?.ui?.toggleConversation?.(jump.dataset.id);
    return;
  }

  const copy = e.target.closest('.copy-conv-btn');
  if (copy?.dataset.id) {
    const ok = await copyText(copy.dataset.id);
    showToast(ok ? '已复制会话 ID' : '复制失败', !ok);
    return;
  }

  const qEdit = e.target.closest('.q-edit-btn');
  if (qEdit?.dataset.id) {
    const row = (state.snap?.parsed?.queue || []).find((x) => x.id === qEdit.dataset.id);
    if (row) {
      $('qf-originalId').value = row.id;
      $('qf-id').value = row.id;
      $('qf-summary').value = row.summary;
      $('qf-status').value = row.status;
      $('qf-route').value = row.route;
    }
    return;
  }

  const qDel = e.target.closest('.q-del-btn');
  if (qDel?.dataset.id) {
    const taskId = qDel.dataset.id;
    await confirmInline(qDel, '确认删除?', async () => {
      try {
        const res = await api('/api/queue/delete', {
          method: 'POST',
          body: {
            workspace: state.workspace,
            relPath: state.snap.registryRelPath,
            expectedHash: state.snap.hash,
            id: taskId,
          },
        });
        render(res.snapshot);
        showToast(`已删除任务 ${taskId}`);
      } catch (err) {
        showToast(err.message, true);
      }
    });
    return;
  }

  const copyTpl = e.target.closest('.copy-tpl');
  if (copyTpl?.dataset.tpl) {
    const ok = await copyText(state.snap?.templates?.[copyTpl.dataset.tpl] || '');
    showToast(ok ? '已复制模板到剪贴板' : '复制失败', !ok);
  }
});

async function bootstrapSidecar() {
  let bootstrappedWs = null;
  if (typeof window.sidecar?.getWorkspaceUris === 'function') {
    try {
      const uris = await Promise.race([
        window.sidecar.getWorkspaceUris(),
        new Promise((r) => setTimeout(() => r(null), 1500)),
      ]);
      if (Array.isArray(uris) && uris.length > 0 && uris[0]) {
        bootstrappedWs = uris[0];
      }
    } catch {
      bootstrappedWs = null;
    }
  }

  if (typeof window.sidecar?.onWorkspaceChange === 'function') {
    window.sidecar.onWorkspaceChange((uris) => {
      const nextWs = Array.isArray(uris) && uris.length > 0 ? uris[0] || '' : '';
      if (nextWs && nextWs === state.workspace && state.snap) return;
      if (nextWs) {
        refresh(nextWs, { recordSelection: true });
      } else if (!state.snap) {
        refresh('');
      }
    });
  }

  if (bootstrappedWs) {
    await refresh(bootstrappedWs, { recordSelection: true });
  } else {
    await refresh('');
  }
}

bootstrapSidecar();
