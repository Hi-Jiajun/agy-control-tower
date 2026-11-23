import {
  buildPrefilledHandoverText,
  computeControllerHealth,
  computeLivePollPlan,
  computeTabVisibility,
  escHtml,
  formatFlightEventRow,
  isLeaseIdle,
  summarizeDiagnosticsBadge,
} from './ui-logic.mjs';

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
  pollPausedByUser: false,
  rawDirty: false,
  lastProbe: null,
  diagLoaded: false,
};

  function syncTheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #0f172a)';
    document.documentElement.appendChild(probe);
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

  const esc = escHtml;

  function showToast(msg, isErr = false) {
    const el = $('toast');
    el.textContent = msg;
    el.className = isErr ? 'toast error' : 'toast';
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
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

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
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
      loadDiagnostics({ silent: true });
    }
  }

  function switchSettingsScope(scope) {
    state.settingsScope = scope;
    document.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.scope === scope);
    });
    ['plugin', 'global', 'workspace'].forEach((name) => {
      $(`settings-scope-${name}`).classList.toggle('hidden', name !== scope);
    });
    if (scope === 'plugin') {
      loadDiagnostics({ silent: true });
    }
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

  function renderAttentionBanner(snap) {
    const enabled = snap?.settings?.plugin?.attentionBannerEnabled !== false;
    const items = Array.isArray(snap?.attention?.items) ? snap.attention.items : [];
    const banner = $('attention-banner');
    if (!enabled || items.length === 0) {
      banner.classList.add('hidden');
      $('attention-list').innerHTML = '';
      return;
    }
    banner.classList.remove('hidden');
    $('attention-list').innerHTML = items
      .map((item) => {
        const isHandover = item.kind === 'handover';
        const ctrlId = item.controllerId || snap?.parsed?.controller?.currentControllerId || '';
        const actionBtns = isHandover
          ? `
            <button class="btn btn-primary btn-sm spawn-handover-btn" data-id="${esc(ctrlId)}">一键接班</button>
            <button class="btn btn-ghost btn-sm jump-conv-btn" data-id="${esc(ctrlId)}">跳转总控</button>
            <button class="btn btn-ghost btn-sm dismiss-att-btn" data-kind="handover" data-ctrl="${esc(ctrlId)}">本会话忽略</button>
          `
          : `
            <button class="btn btn-primary btn-sm jump-conv-btn" data-id="${esc(ctrlId)}">跳转总控拍板</button>
            <button class="btn btn-ghost btn-sm dismiss-att-btn" data-id="${esc(item.id)}">已处理</button>
          `;
        return `
          <div class="attention-item">
            <span>${esc(item.summary || item.kind)}</span>
            <div class="actions">${actionBtns}</div>
          </div>
        `;
      })
      .join('');
  }

  function renderOverview(snap) {
    const eff = snap.settings?.effective || {};
    const leaseEnabled = eff.exclusiveLeaseEnabled !== false;
    const lease = snap.parsed?.lease || {};
    const statusText = leaseEnabled ? lease.lockStatus || '-' : '无独占资源模式';
    const pill = $('lease-status-pill');
    pill.textContent = statusText;
    const isIdle = isLeaseIdle(statusText, leaseEnabled);
    pill.className = `badge ${isIdle ? 'badge-ok' : 'badge-warn'}`;

    $('lease-disabled-note').classList.toggle('hidden', leaseEnabled);
    $('lease-active-wrap').classList.toggle('hidden', !leaseEnabled);

    if (leaseEnabled) {
      $('lease-view').innerHTML = [
        ['锁状态', lease.lockStatus || '-'],
        ['持锁会话', lease.holder || '-'],
        ['独占对象', lease.resource || '-'],
        ['起始时间', lease.since || '-'],
        ['操作范围', lease.scope || '-'],
        ['解锁判据', lease.releaseCriteria || '-'],
      ]
        .map(([k, v]) => `<div class="kv-k">${esc(k)}</div><div class="kv-v">${esc(v)}</div>`)
        .join('');

      $('lf-lockStatus').value = lease.lockStatus || '';
      $('lf-holder').value = lease.holder || '-';
      $('lf-resource').value = lease.resource || '-';
      $('lf-since').value = lease.since || '-';
      $('lf-scope').value = lease.scope || '-';
      $('lf-releaseCriteria').value = lease.releaseCriteria || '-';
    }

    const ctrl = snap.parsed?.controller || {};
    const tel = ctrl.telemetry || {};
    const health = computeControllerHealth({
      compactions: Number(tel.compactions || 0),
      threshold: Number(eff.controllerCompactionThreshold || 5),
      ignored: Boolean(snap?.attention?.handoverIgnored),
    });
    const compBadge = $('ctrl-comp-badge');
    compBadge.textContent = health.badgeText;
    compBadge.className = `badge ${health.badgeClass}`;
    $('ctrl-alert').classList.toggle('hidden', !health.showAlert);
    $('ctrl-alert-text').textContent = health.alertText;

    const autoBadge = $('ctrl-autonomy-badge');
    const autoLabel = eff.effectiveAutonomy || 'balanced';
    autoBadge.textContent = `代决策: ${autoLabel}`;

    const stepStr = tel.exists ? `${tel.maxStepIndex || tel.lineCount} 步 (${tel.lineCount} 条)` : '未定位到日志';
    $('ctrl-view').innerHTML = [
      ['总控 ID', ctrl.currentControllerId || '未登记'],
      ['常驻模型', ctrl.defaultModel || eff.l0ControllerModel || '-'],
      ['运行状态', `${ctrl.currentControllerStatus || '-'} | ${tel.lastModel || '-'}`],
      ['日志进度', `${stepStr}${tel.lastUpdatedAt ? ` | ${tel.lastUpdatedAt}` : ''}`],
    ]
      .map(([k, v]) => `<div class="kv-k">${esc(k)}</div><div class="kv-v">${esc(v)}</div>`)
      .join('');

    $('cf-controllerId').value = ctrl.currentControllerId || window.sidecar?.conversationId || '';
    $('cf-status').value = ctrl.currentControllerStatus || 'ONLINE';
    $('cf-defaultModel').value = ctrl.defaultModel || eff.l0ControllerModel || 'Orchestrator (Neon)';
  }

  function renderSessions(snap) {
    const eff = snap.settings?.effective || {};
    const leaseEnabled = eff.exclusiveLeaseEnabled !== false;
    $('df-lock-wrap').classList.toggle('hidden', !leaseEnabled);
    if (!$('df-model').dataset.userEdited) {
      $('df-model').value = eff.l2StandardModel || 'Orchestrator (Neon)';
    }

    // Native Swarm panel
    const swarm = snap.nativeSwarm || { active: false, members: [], recentPosts: [] };
    const swarmCard = $('swarm-card');
    swarmCard.classList.toggle('hidden', !swarm.active);
    if (swarm.active) {
      $('swarm-title-badge').textContent = `${swarm.title} | ${swarm.members.length} 成员`;
      $('swarm-members-list').innerHTML = swarm.members
        .map((m) => {
          const stCls =
            m.state === 'working'
              ? 'badge-ok'
              : m.state === 'killed'
                ? 'badge-danger'
                : 'badge-muted';
          return `
            <div class="item-box">
              <div class="card-head">
                <strong>${esc(m.name)} (${esc(m.role)})</strong>
                <span class="badge ${stCls}">${esc(m.state)}</span>
              </div>
              <div class="item-meta">模型: ${esc(m.model)} | 步数: ${esc(m.steps)} | 压缩: ${esc(m.compactions)} 次</div>
              ${m.lastError ? `<div class="item-meta">报错: ${esc(m.lastError)}</div>` : ''}
              ${
                m.conversationId
                  ? `<div class="actions">
                      <button class="btn btn-ghost btn-sm jump-conv-btn" data-id="${esc(m.conversationId)}">跳转成员会话</button>
                      <button class="btn btn-ghost btn-sm copy-conv-btn" data-id="${esc(m.conversationId)}">复制 ID</button>
                    </div>`
                  : ''
              }
            </div>
          `;
        })
        .join('');
      $('swarm-posts-list').innerHTML =
        swarm.recentPosts.length === 0
          ? ''
          : `<div class="divider-label">最近消息板动态</div>` +
            swarm.recentPosts
              .map(
                (p) =>
                  `<div class="item-meta">#${esc(p.seq)} [${esc(p.agent)}]: ${esc(p.text)}</div>`
              )
              .join('');
    }

    const active = snap.parsed?.activeSessions || [];
    const workerThresh = Number(eff.workerCompactionThreshold || 2);
    $('active-count-badge').textContent = String(active.length);
    const activeBox = $('active-sessions-list');
    if (active.length === 0) {
      activeBox.innerHTML = '<p class="muted">暂无活跃或挂起专职会话</p>';
    } else {
      activeBox.innerHTML = active
        .map((s) => {
          const t = s.telemetry || {};
          const compWarn = (t.compactions || 0) >= workerThresh ? 'badge-danger' : 'badge-muted';
          const telLine = t.exists
            ? `步数 ${t.maxStepIndex || t.lineCount} | 模型 ${t.lastModel || '-'} | 压缩 ${t.compactions} 次`
            : '无本地日志';
          return `
            <div class="item-box">
              <div class="card-head">
                <strong>${esc(s.topic || '未命名任务')}</strong>
                <span class="badge ${compWarn}">${esc(s.status || '-')}</span>
              </div>
              <div class="item-meta">ID: ${esc(s.conversationId || '-')} | 锁: ${esc(s.lockStatus || '-')}</div>
              <div class="item-meta">${esc(telLine)}</div>
              <div class="actions">
                <button class="btn btn-ghost btn-sm jump-conv-btn" data-id="${esc(s.conversationId)}">跳转会话</button>
                <button class="btn btn-ghost btn-sm copy-conv-btn" data-id="${esc(s.conversationId)}">复制 ID</button>
                <button class="btn btn-ghost btn-sm notify-ctrl-btn" data-id="${esc(s.conversationId)}">通知总控</button>
                <button class="btn btn-warn btn-sm archive-conv-btn" data-id="${esc(s.conversationId)}" data-topic="${esc(s.topic)}">归档里程碑</button>
              </div>
            </div>
          `;
        })
        .join('');
    }

    const archived = snap.parsed?.archivedSessions || [];
    $('archived-count-badge').textContent = String(archived.length);
    const archBox = $('archived-sessions-list');
    archBox.innerHTML =
      archived.length === 0
        ? '<p class="muted">暂无归档记录</p>'
        : archived
            .map(
              (a) => `
              <div class="item-box">
                <strong>${esc(a.milestone || a.conversationId || '-')}</strong>
                <div class="item-meta">${esc(a.summary || '-')}</div>
              </div>
            `
            )
            .join('');
  }

  function renderQueue(snap) {
    const queue = snap.parsed?.queue || [];
    const eff = snap.settings?.effective || {};
    if (!$('qf-originalId').value && !$('qf-route').dataset.userEdited) {
      $('qf-route').value = `L2 ${eff.l2StandardModel || 'Orchestrator (Neon)'}`;
    }
    $('queue-count-badge').textContent = String(queue.length);
    const box = $('queue-list');
    if (queue.length === 0) {
      box.innerHTML = '<p class="muted">待调度队列为空</p>';
      return;
    }
    box.innerHTML = queue
      .map(
        (q) => `
        <div class="item-box">
          <div class="card-head">
            <strong>${esc(q.id)}</strong>
            <span class="badge">${esc(q.status)}</span>
          </div>
          <div class="item-meta">${esc(q.summary)}</div>
          <div class="item-meta">路线: ${esc(q.route)}</div>
          <div class="actions">
            <button class="btn btn-ghost btn-sm q-edit-btn" data-id="${esc(q.id)}">编辑</button>
            <button class="btn btn-danger btn-sm q-del-btn" data-id="${esc(q.id)}">删除</button>
          </div>
        </div>
      `
      )
      .join('');
  }

  function renderRaw(snap) {
    $('raw-hash-badge').textContent = snap.hash ? snap.hash.slice(0, 10) : '-';
    const tplSrc = snap.settings?.docs?.['templates.md']?.source || 'builtin';
    $('tpl-source-badge').textContent = tplSrc;
    if (!state.rawDirty) {
      $('raw-editor').value = snap.content || '';
    }
  }

  function setOvTag(key, isWsOverride) {
    const el = $(`ov-tag-${key}`);
    if (!el) return;
    el.textContent = isWsOverride ? '工作区覆盖' : '继承全局';
    el.className = `badge ${isWsOverride ? 'badge-warn' : 'badge-muted'}`;
  }

  function syncGlobalDocEditor(snap) {
    const docName = $('global-doc-select').value;
    const docs = snap.settings?.docs || {};
    const d = docs[docName] || {};
    const hasGlobal = Boolean(d.hasGlobalOverride);
    $('global-doc-badge').textContent = hasGlobal ? '已存在全局覆盖' : '使用内置基准';
    $('global-doc-badge').className = `badge ${hasGlobal ? 'badge-warn' : 'badge-muted'}`;
    if (document.activeElement !== $('global-doc-editor')) {
      $('global-doc-editor').value =
        d.source === 'global' ? d.content || '' : d.builtinContent || d.content || '';
    }
  }

  function syncWsDocEditor(snap) {
    const docName = $('ws-doc-select').value;
    const docs = snap.settings?.docs || {};
    const d = docs[docName] || {};
    const hasWs = Boolean(d.hasWorkspaceOverride);
    $('ws-doc-badge').textContent = hasWs ? '已存在工作区覆盖' : `继承 (${d.source || 'builtin'})`;
    $('ws-doc-badge').className = `badge ${hasWs ? 'badge-warn' : 'badge-muted'}`;
    if (document.activeElement !== $('ws-doc-editor')) {
      $('ws-doc-editor').value = d.content || '';
    }
  }

  function renderSettings(snap) {
    const s = snap.settings || {};
    const p = s.plugin || {};
    const g = s.global || {};
    const w = s.workspace || {};
    const eff = s.effective || {};
    const ov = w.overrides || {};
    const hp = s.hostPermission || {};

    // Layer 1: Plugin
    $('ps-livePollEnabled').checked = p.livePollEnabled !== false;
    $('ps-livePollIntervalSec').value = String(p.livePollIntervalSec ?? 4);
    $('ps-uiMotion').value = p.uiMotion || 'standard';
    $('ps-attentionBannerEnabled').checked = p.attentionBannerEnabled !== false;
    $('ps-dualRoleHookEnabled').checked = p.dualRoleHookEnabled !== false;
    $('ps-stopHookReportEnabled').checked = p.stopHookReportEnabled !== false;
    $('ps-registryWriteGuard').value = p.registryWriteGuard || 'ask';
    $('ps-maxLookupInputLength').value = String(p.maxLookupInputLength ?? 2000);
    $('ps-maxLookupCandidates').value = String(p.maxLookupCandidates ?? 6);

    // Layer 2: Global
    const hostDesc = hp.available
      ? `宿主权限检测: preset=${hp.permissionPreset || '-'} | exec=${hp.autoExecutionPolicy || '-'} -> 映射档位: ${eff.effectiveAutonomy || 'balanced'}`
      : `未检测到宿主权限文件，跟随模式下默认采用 balanced 均衡档`;
    $('host-perm-summary').textContent = hostDesc;
    $('gs-l0ControllerModel').value = g.l0ControllerModel || 'Orchestrator (Neon)';
    $('gs-l1LightModel').value = g.l1LightModel || 'Gemini 4 Hydrogen (Low)';
    $('gs-l2StandardModel').value = g.l2StandardModel || 'Orchestrator (Neon)';
    $('gs-l3DeepModel').value = g.l3DeepModel || 'Orchestrator (Carbon)';
    $('gs-l4IntegrationModel').value = g.l4IntegrationModel || 'Orchestrator (Neon)';
    $('gs-modelGuardPolicy').value = g.modelGuardPolicy || 'strict_gemini4';
    $('gs-customAllowedModels').value = Array.isArray(g.customAllowedModels)
      ? g.customAllowedModels.join(', ')
      : '';
    $('gs-decisionAutonomy').value = g.decisionAutonomy || 'inherit';
    $('gs-askBeforeDispatch').checked = g.askBeforeDispatch !== false;
    $('gs-notifyOnSingleTaskDone').checked = Boolean(g.notifyOnSingleTaskDone);
    $('gs-controllerCompactionThreshold').value = String(g.controllerCompactionThreshold ?? 5);
    $('gs-workerCompactionThreshold').value = String(g.workerCompactionThreshold ?? 2);
    syncGlobalDocEditor(snap);

    // Layer 3: Workspace
    const hasWs = Boolean(snap.workspace);
    $('ws-settings-empty').classList.toggle('hidden', hasWs);
    $('ws-settings-body').classList.toggle('hidden', !hasWs);
    if (hasWs) {
      $('ws-settings-badge').textContent = snap.workspace.split('/').filter(Boolean).pop() || 'workspace';
      $('ws-exclusiveLeaseEnabled').checked = w.exclusiveLeaseEnabled !== false;
      $('ws-registryMode').value = w.registryMode || 'workspace_auto';
      $('ws-customRegistryRelPath').value = w.customRegistryRelPath || '';
      $('ws-custom-rel-wrap').classList.toggle('hidden', $('ws-registryMode').value !== 'workspace_custom');

      ['l0ControllerModel', 'l2StandardModel', 'l3DeepModel'].forEach((k) => {
        const hasOv = Object.prototype.hasOwnProperty.call(ov, k);
        $(`ws-ov-${k}`).value = hasOv ? ov[k] : '';
        $(`ws-ov-${k}`).placeholder = `继承全局 (${g[k] || '-'})`;
        setOvTag(k, hasOv);
      });

      const hasAutoOv = Object.prototype.hasOwnProperty.call(ov, 'decisionAutonomy');
      $('ws-ov-decisionAutonomy').value = hasAutoOv ? ov.decisionAutonomy : '';
      setOvTag('decisionAutonomy', hasAutoOv);

      const hasAskOv = Object.prototype.hasOwnProperty.call(ov, 'askBeforeDispatch');
      $('ws-ov-askBeforeDispatch').value = hasAskOv ? String(ov.askBeforeDispatch) : '';
      setOvTag('askBeforeDispatch', hasAskOv);

      const hasNotifyOv = Object.prototype.hasOwnProperty.call(ov, 'notifyOnSingleTaskDone');
      $('ws-ov-notifyOnSingleTaskDone').value = hasNotifyOv ? String(ov.notifyOnSingleTaskDone) : '';
      setOvTag('notifyOnSingleTaskDone', hasNotifyOv);

      const hasThreshOv = Object.prototype.hasOwnProperty.call(ov, 'controllerCompactionThreshold');
      $('ws-ov-controllerCompactionThreshold').value = hasThreshOv
        ? String(ov.controllerCompactionThreshold)
        : '';
      $('ws-ov-controllerCompactionThreshold').placeholder = `继承全局 (${g.controllerCompactionThreshold ?? 5})`;
      setOvTag('controllerCompactionThreshold', hasThreshOv);

      syncWsDocEditor(snap);
    }
  }

  function updateLivePollControls(snap) {
    const plan = computeLivePollPlan({
      pluginPollEnabled: snap?.settings?.plugin?.livePollEnabled !== false,
      pausedByUser: state.pollPausedByUser,
      intervalSec: Number(snap?.settings?.plugin?.livePollIntervalSec || 4),
      activeSessionCount: (snap?.parsed?.activeSessions || []).length,
      swarmActive: Boolean(snap?.nativeSwarm?.active),
    });
    $('live-dot').classList.toggle('live', plan.dotLive);
    const btn = $('poll-toggle-btn');
    btn.classList.toggle('active', plan.isLive);
    btn.textContent = plan.buttonText;

    clearInterval(state.pollTimer);
    state.pollTimer = null;
    if (plan.shouldSchedule) {
      state.pollTimer = setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        const activeTag = document.activeElement?.tagName;
        if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return;
        if (state.rawDirty) return;
        const editingFormOpen =
          !$('lease-form').classList.contains('hidden') ||
          !$('ctrl-form').classList.contains('hidden') ||
          !$('session-form').classList.contains('hidden');
        if (editingFormOpen) return;
        refresh(undefined, { silent: true });
      }, plan.intervalMs);
    }
  }

  function renderDiagnostics(payload) {
    const summary = payload?.summary || null;
    const events = Array.isArray(payload?.events) ? payload.events : [];
    const badge = summarizeDiagnosticsBadge(summary);
    const badgeEl = $('diag-health-badge');
    badgeEl.textContent = badge.text;
    badgeEl.className = `badge ${badge.badgeClass}`;

    if (summary) {
      $('diag-stats').textContent =
        `近 ${summary.windowHours || 24}h: 共 ${summary.total || 0} 条 | ` +
        `慢调用 ${summary.slowCount || 0} | 写保护拦截 ${summary.guardBlockedCount || 0} | ` +
        `跳过唤醒 ${summary.wakeSkippedCount || 0}`;
    }

    const listEl = $('diag-events-list');
    if (events.length === 0) {
      listEl.innerHTML = '<p class="muted">暂无匹配的飞行诊断事件。</p>';
      return;
    }
    listEl.innerHTML = events
      .map((ev) => {
        const row = formatFlightEventRow(ev);
        return `
          <div class="diag-row">
            <div class="diag-head">
              <span class="diag-title">${esc(row.timeLabel)} | ${esc(row.title)}</span>
              <span class="badge ${row.levelClass}">${esc(row.level)}</span>
            </div>
            ${row.message ? `<div class="diag-msg">${esc(row.message)}</div>` : ''}
          </div>
        `;
      })
      .join('');
  }

  async function loadDiagnostics({ silent = false } = {}) {
    try {
      const level = $('diag-level-filter')?.value || '';
      const qs = level ? `?limit=60&level=${encodeURIComponent(level)}` : '?limit=60';
      const data = await api(`/api/diagnostics${qs}`);
      state.diagLoaded = true;
      renderDiagnostics(data);
    } catch (err) {
      if (!silent) showToast(err.message, true);
    }
  }

  function render(snap) {
    state.snap = snap;
    $('version-badge').textContent = `v${snap.plugin?.version || '1.3.0'}`;
    applyMotionSetting(snap);
    renderWorkspaces(snap);
    renderAttentionBanner(snap);

    const hasReg = Boolean(snap.registryExists);
    $('empty-ws-path').textContent = snap.workspace ? `当前工作区: ${snap.workspace}` : '';
    switchTab(state.tab);
    renderSettings(snap);

    if (hasReg) {
      renderOverview(snap);
      renderSessions(snap);
      renderQueue(snap);
      renderRaw(snap);
    }
    updateLivePollControls(snap);
  }

  async function refresh(wsOverride, { recordSelection = false, silent = false } = {}) {
    const targetWs = wsOverride !== undefined ? wsOverride : state.workspace;
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
      state.workspace = snap.workspace || '';
      if (!silent) {
        state.rawDirty = false;
        $('conflict-banner').classList.add('hidden');
      }
      render(snap);
    } catch (err) {
      if (!silent) showToast(err.message, true);
    }
  }

  function buildPrefilledHandover() {
    return buildPrefilledHandoverText(state.snap);
  }

  async function spawnHandoverController(oldCtrlId) {
    const snap = state.snap;
    const eff = snap?.settings?.effective || {};
    const model = eff.l0ControllerModel || 'Orchestrator (Neon)';
    const handoverPrompt = buildPrefilledHandover();
    try {
      const res = await api('/_sidecar/new-conversation', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          model,
          title: 'Control Tower 换届接班总控',
          message: handoverPrompt,
        },
      });
      const cid =
        res.result?.conversationId ||
        res.result?.conversation_id ||
        res.result?.response?.conversationId ||
        '';
      showToast(cid ? `已拉起接班总控 ${cid.slice(0, 8)}` : '已发起换届接班会话');
      if (cid) {
        window.sidecar?.ui?.toggleConversation?.(cid);
      } else if (oldCtrlId) {
        await copyText(handoverPrompt);
      }
    } catch (err) {
      showToast(err.message, true);
    }
  }

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchSettingsScope(btn.dataset.scope));
  });

  $('poll-toggle-btn').addEventListener('click', () => {
    state.pollPausedByUser = !state.pollPausedByUser;
    if (state.snap) updateLivePollControls(state.snap);
  });

  $('refresh-btn').addEventListener('click', () => refresh());
  $('ws-select').addEventListener('change', (e) => {
    if (e.target.value) refresh(e.target.value, { recordSelection: true });
  });

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

  $('edit-lease-btn').addEventListener('click', () => $('lease-form').classList.toggle('hidden'));
  $('cancel-lease-btn').addEventListener('click', () => $('lease-form').classList.add('hidden'));

  $('lease-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/lease/update', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          relPath: state.snap.registryRelPath,
          expectedHash: state.snap.hash,
          lockStatus: $('lf-lockStatus').value,
          holder: $('lf-holder').value,
          resource: $('lf-resource').value,
          since: $('lf-since').value,
          scope: $('lf-scope').value,
          releaseCriteria: $('lf-releaseCriteria').value,
        },
      });
      $('lease-form').classList.add('hidden');
      render(res.snapshot);
      showToast('已更新独占资源租约');
    } catch (err) {
      if (err.status === 409) $('conflict-banner').classList.remove('hidden');
      showToast(err.message, true);
    }
  });

  $('release-lease-btn').addEventListener('click', async () => {
    try {
      const res = await api('/api/lease/update', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          relPath: state.snap.registryRelPath,
          expectedHash: state.snap.hash,
          action: 'release',
        },
      });
      render(res.snapshot);
      showToast('已一键释放独占锁为 IDLE');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('edit-ctrl-btn').addEventListener('click', () => $('ctrl-form').classList.toggle('hidden'));
  $('cancel-ctrl-btn').addEventListener('click', () => $('ctrl-form').classList.add('hidden'));

  $('ctrl-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/controller/update', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          relPath: state.snap.registryRelPath,
          expectedHash: state.snap.hash,
          controllerId: $('cf-controllerId').value.trim(),
          status: $('cf-status').value,
          defaultModel: $('cf-defaultModel').value.trim(),
          appendHistory: $('cf-appendHistory').checked,
          summary: $('cf-summary').value.trim(),
        },
      });
      $('ctrl-form').classList.add('hidden');
      render(res.snapshot);
      showToast('已更新现役总控配置');
    } catch (err) {
      if (err.status === 409) $('conflict-banner').classList.remove('hidden');
      showToast(err.message, true);
    }
  });

  $('jump-ctrl-btn').addEventListener('click', () => {
    const id = state.snap?.parsed?.controller?.currentControllerId;
    if (!id) return showToast('未登记总控 ID', true);
    window.sidecar?.ui?.toggleConversation?.(id);
  });

  $('copy-ctrl-id-btn').addEventListener('click', async () => {
    const id = state.snap?.parsed?.controller?.currentControllerId;
    const ok = id ? await copyText(id) : false;
    showToast(ok ? '已复制总控 ID' : '暂无可复制的总控 ID', !ok);
  });

  const handleCopyHandover = async () => {
    const ok = await copyText(buildPrefilledHandover());
    showToast(ok ? '已复制预填换届交接卡' : '复制失败', !ok);
  };
  $('copy-handover-btn').addEventListener('click', handleCopyHandover);
  $('copy-handover-raw-btn').addEventListener('click', handleCopyHandover);

  $('ctrl-handover-spawn-btn').addEventListener('click', () => {
    spawnHandoverController(state.snap?.parsed?.controller?.currentControllerId || '');
  });

  $('ctrl-ignore-handover-btn').addEventListener('click', async () => {
    const ctrlId = state.snap?.parsed?.controller?.currentControllerId || '';
    try {
      const res = await api('/api/attention/dismiss', {
        method: 'POST',
        body: { workspace: state.workspace, kind: 'handover', controllerId: ctrlId, ignoreForSession: true },
      });
      render(res.snapshot);
      showToast('已标记当前总控会话忽略换届提醒');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Dispatch form
  $('toggle-dispatch-btn').addEventListener('click', () => $('dispatch-form').classList.toggle('hidden'));
  $('df-model').addEventListener('input', () => {
    $('df-model').dataset.userEdited = '1';
  });

  $('dispatch-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/dispatch/create', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          expectedHash: state.snap?.hash,
          topic: $('df-topic').value.trim(),
          title: $('df-topic').value.trim(),
          model: $('df-model').value.trim(),
          slashPrefix: $('df-slash').value,
          lockStatus: $('df-lock').value,
          prompt: $('df-prompt').value.trim(),
        },
      });
      $('df-topic').value = '';
      $('df-prompt').value = '';
      render(res.snapshot);
      showToast(
        res.conversationId
          ? `已拉起专职会话 ${res.conversationId.slice(0, 8)}${res.enrolled ? ' 并入账' : ''}`
          : '已拉起专职会话'
      );
    } catch (err) {
      if (err.status === 409) $('conflict-banner').classList.remove('hidden');
      showToast(err.message, true);
    }
  });

  $('df-copy-btn').addEventListener('click', async () => {
    const tpl = state.snap?.templates?.dispatchOfflineTemplate || '';
    const topic = $('df-topic').value.trim() || '<唯一目标>';
    const prompt = $('df-prompt').value.trim() || '<验证判据>';
    const prefix = $('df-slash').value ? `${$('df-slash').value} ` : '';
    const ctrlId = state.snap?.parsed?.controller?.currentControllerId || '<controllerId>';
    const filled = `${prefix}${tpl
      .replace('<编号> — <唯一目标>', topic)
      .replace('<controllerId>', ctrlId)}\n\n补充需求说明：${prompt}`;
    const ok = await copyText(filled);
    showToast(ok ? '已复制直派兜底开场词' : '复制失败', !ok);
  });

  $('toggle-session-form-btn').addEventListener('click', () => $('session-form').classList.toggle('hidden'));
  $('cancel-session-form-btn').addEventListener('click', () => $('session-form').classList.add('hidden'));

  $('session-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/sessions/upsert', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          relPath: state.snap.registryRelPath,
          expectedHash: state.snap.hash,
          conversationId: $('sf-id').value.trim(),
          topic: $('sf-topic').value.trim(),
          modelTool: $('sf-modelTool').value.trim(),
          lockStatus: $('sf-lockStatus').value.trim(),
          status: $('sf-status').value,
          paths: $('sf-paths').value.trim(),
        },
      });
      $('session-form').classList.add('hidden');
      $('session-form').reset();
      render(res.snapshot);
      showToast('已入账活跃专职会话');
    } catch (err) {
      if (err.status === 409) $('conflict-banner').classList.remove('hidden');
      showToast(err.message, true);
    }
  });

  $('probe-btn').addEventListener('click', async () => {
    const id = $('probe-id-input').value.trim();
    if (!id) return;
    const box = $('probe-result');
    box.classList.remove('hidden');
    try {
      const data = await api(`/api/session/inspect?id=${encodeURIComponent(id)}`);
      state.lastProbe = data.status === 'ok' ? data : null;
      if (data.status !== 'ok') {
        box.innerHTML = `<div class="item-meta">状态: ${esc(data.status)} ${data.matches?.length ? `| 匹配: ${esc(data.matches.join(', '))}` : ''}</div>`;
        return;
      }
      const info = data.info || {};
      box.innerHTML = `
        <div><strong>${esc(data.conversationId)}</strong></div>
        <div class="item-meta">目标: ${esc(info.goal || '-')}</div>
        <div class="item-meta">步数: ${esc(info.maxStepIndex || info.lineCount)} | 模型: ${esc(info.lastModel || '-')} | 压缩: ${esc(info.compactions)} 次</div>
        <div class="item-meta">更新: ${esc(info.lastUpdatedAt || '-')} | 状态: ${esc(info.lastStatus || '-')}</div>
        <div class="actions">
          <button class="btn btn-primary btn-sm enroll-probe-btn">一键入账活跃表</button>
          <button class="btn btn-ghost btn-sm notify-ctrl-btn" data-id="${esc(data.conversationId)}">投递裸 ID 给总控</button>
          <button class="btn btn-ghost btn-sm jump-conv-btn" data-id="${esc(data.conversationId)}">跳转会话</button>
        </div>
      `;
    } catch (err) {
      box.innerHTML = `<div class="item-meta">${esc(err.message)}</div>`;
    }
  });

  // Settings Center Events
  $('plugin-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/settings/plugin', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          livePollEnabled: $('ps-livePollEnabled').checked,
          livePollIntervalSec: Number($('ps-livePollIntervalSec').value),
          uiMotion: $('ps-uiMotion').value,
          attentionBannerEnabled: $('ps-attentionBannerEnabled').checked,
          dualRoleHookEnabled: $('ps-dualRoleHookEnabled').checked,
          stopHookReportEnabled: $('ps-stopHookReportEnabled').checked,
          registryWriteGuard: $('ps-registryWriteGuard').value,
          maxLookupInputLength: Number($('ps-maxLookupInputLength').value),
          maxLookupCandidates: Number($('ps-maxLookupCandidates').value),
        },
      });
      render(res.snapshot);
      showToast('已保存插件设置');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('ps-reset-btn').addEventListener('click', async () => {
    try {
      const res = await api('/api/settings/plugin', {
        method: 'POST',
        body: { workspace: state.workspace, action: 'reset' },
      });
      render(res.snapshot);
      showToast('已恢复插件默认设置');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('clear-cache-btn').addEventListener('click', async () => {
    try {
      const res = await api('/api/cache/clear', {
        method: 'POST',
        body: { workspace: state.workspace },
      });
      render(res.snapshot);
      showToast('已清理遥测缓存');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('diag-level-filter').addEventListener('change', () => loadDiagnostics());
  $('diag-refresh-btn').addEventListener('click', () => loadDiagnostics());
  $('diag-clear-btn').addEventListener('click', async () => {
    try {
      const data = await api('/api/diagnostics/clear', { method: 'POST', body: {} });
      renderDiagnostics(data);
      showToast('已清空黑匣子诊断日志');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('global-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const customRaw = $('gs-customAllowedModels').value
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      const res = await api('/api/settings/global', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          l0ControllerModel: $('gs-l0ControllerModel').value.trim(),
          l1LightModel: $('gs-l1LightModel').value.trim(),
          l2StandardModel: $('gs-l2StandardModel').value.trim(),
          l3DeepModel: $('gs-l3DeepModel').value.trim(),
          l4IntegrationModel: $('gs-l4IntegrationModel').value.trim(),
          modelGuardPolicy: $('gs-modelGuardPolicy').value,
          customAllowedModels: customRaw,
          decisionAutonomy: $('gs-decisionAutonomy').value,
          askBeforeDispatch: $('gs-askBeforeDispatch').checked,
          notifyOnSingleTaskDone: $('gs-notifyOnSingleTaskDone').checked,
          controllerCompactionThreshold: Number($('gs-controllerCompactionThreshold').value),
          workerCompactionThreshold: Number($('gs-workerCompactionThreshold').value),
        },
      });
      render(res.snapshot);
      showToast('已保存全局设置');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('gs-reset-btn').addEventListener('click', async () => {
    try {
      const res = await api('/api/settings/global', {
        method: 'POST',
        body: { workspace: state.workspace, action: 'reset' },
      });
      render(res.snapshot);
      showToast('已重置全局设置为内置默认');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('global-doc-select').addEventListener('change', () => {
    if (state.snap) {
      $('global-doc-editor').blur();
      syncGlobalDocEditor(state.snap);
    }
  });

  $('global-doc-load-builtin-btn').addEventListener('click', () => {
    const docName = $('global-doc-select').value;
    const d = state.snap?.settings?.docs?.[docName];
    if (d) $('global-doc-editor').value = d.builtinContent || d.content || '';
  });

  $('global-doc-save-btn').addEventListener('click', async () => {
    try {
      const res = await api('/api/settings/override', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          scope: 'global',
          docName: $('global-doc-select').value,
          content: $('global-doc-editor').value,
        },
      });
      render(res.snapshot);
      showToast('已保存全局文档覆盖');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('global-doc-reset-btn').addEventListener('click', async () => {
    try {
      const res = await api('/api/settings/override', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          scope: 'global',
          docName: $('global-doc-select').value,
          action: 'reset',
        },
      });
      render(res.snapshot);
      showToast('已清除全局文档覆盖');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('ws-registryMode').addEventListener('change', () => {
    $('ws-custom-rel-wrap').classList.toggle('hidden', $('ws-registryMode').value !== 'workspace_custom');
  });

  $('ws-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.workspace) return;
    const overrides = {};
    ['l0ControllerModel', 'l2StandardModel', 'l3DeepModel'].forEach((k) => {
      const v = $(`ws-ov-${k}`).value.trim();
      overrides[k] = v || null;
    });
    overrides.decisionAutonomy = $('ws-ov-decisionAutonomy').value || null;
    const askVal = $('ws-ov-askBeforeDispatch').value;
    overrides.askBeforeDispatch = askVal === '' ? null : askVal === 'true';
    const notifyVal = $('ws-ov-notifyOnSingleTaskDone').value;
    overrides.notifyOnSingleTaskDone = notifyVal === '' ? null : notifyVal === 'true';
    const threshVal = $('ws-ov-controllerCompactionThreshold').value.trim();
    overrides.controllerCompactionThreshold = threshVal ? Number(threshVal) : null;

    try {
      const res = await api('/api/settings/workspace', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          exclusiveLeaseEnabled: $('ws-exclusiveLeaseEnabled').checked,
          registryMode: $('ws-registryMode').value,
          customRegistryRelPath: $('ws-customRegistryRelPath').value.trim(),
          overrides,
        },
      });
      render(res.snapshot);
      showToast('已保存当前工作区设置');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('ws-reset-btn').addEventListener('click', async () => {
    if (!state.workspace) return;
    try {
      const res = await api('/api/settings/workspace', {
        method: 'POST',
        body: { workspace: state.workspace, action: 'reset' },
      });
      render(res.snapshot);
      showToast('已重置当前工作区全部设置');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('ws-doc-select').addEventListener('change', () => {
    if (state.snap) {
      $('ws-doc-editor').blur();
      syncWsDocEditor(state.snap);
    }
  });

  $('ws-doc-load-effective-btn').addEventListener('click', () => {
    const docName = $('ws-doc-select').value;
    const d = state.snap?.settings?.docs?.[docName];
    if (d) $('ws-doc-editor').value = d.content || '';
  });

  $('ws-doc-save-btn').addEventListener('click', async () => {
    if (!state.workspace) return;
    try {
      const res = await api('/api/settings/override', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          scope: 'workspace',
          docName: $('ws-doc-select').value,
          content: $('ws-doc-editor').value,
        },
      });
      render(res.snapshot);
      showToast('已保存工作区文档覆盖');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('ws-doc-reset-btn').addEventListener('click', async () => {
    if (!state.workspace) return;
    try {
      const res = await api('/api/settings/override', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          scope: 'workspace',
          docName: $('ws-doc-select').value,
          action: 'reset',
        },
      });
      render(res.snapshot);
      showToast('已清除工作区文档覆盖');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.body.addEventListener('click', async (e) => {
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
      await spawnHandoverController(spawnHandover.dataset.id || '');
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
      try {
        await sendToActiveController(notifyBtn.dataset.id);
        showToast(`已向现役总控投递 ${notifyBtn.dataset.id.slice(0, 8)}`);
      } catch (err) {
        showToast(err.message, true);
      }
      return;
    }

    const archiveBtn = e.target.closest('.archive-conv-btn');
    if (archiveBtn?.dataset.id) {
      const summary = window.prompt(
        `请输入会话 ${archiveBtn.dataset.id.slice(0, 8)} 的归档产出摘要：`,
        '已完成验证并收口'
      );
      if (summary === null) return;
      try {
        const res = await api('/api/sessions/archive', {
          method: 'POST',
          body: {
            workspace: state.workspace,
            relPath: state.snap.registryRelPath,
            expectedHash: state.snap.hash,
            conversationId: archiveBtn.dataset.id,
            milestone: archiveBtn.dataset.topic || '已完成里程碑',
            summary: summary.trim() || '已完成验证并收口',
          },
        });
        render(res.snapshot);
        showToast(`已归档会话 ${archiveBtn.dataset.id.slice(0, 8)}`);
      } catch (err) {
        showToast(err.message, true);
      }
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
      try {
        const res = await api('/api/queue/delete', {
          method: 'POST',
          body: {
            workspace: state.workspace,
            relPath: state.snap.registryRelPath,
            expectedHash: state.snap.hash,
            id: qDel.dataset.id,
          },
        });
        render(res.snapshot);
        showToast(`已删除任务 ${qDel.dataset.id}`);
      } catch (err) {
        showToast(err.message, true);
      }
      return;
    }
    const copyTpl = e.target.closest('.copy-tpl');
    if (copyTpl?.dataset.tpl) {
      const ok = await copyText(state.snap?.templates?.[copyTpl.dataset.tpl] || '');
      showToast(ok ? '已复制模板到剪贴板' : '复制失败', !ok);
    }
  });

  $('qf-route').addEventListener('input', () => {
    $('qf-route').dataset.userEdited = '1';
  });

  $('queue-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/queue/upsert', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          relPath: state.snap.registryRelPath,
          expectedHash: state.snap.hash,
          originalId: $('qf-originalId').value || undefined,
          id: $('qf-id').value.trim(),
          summary: $('qf-summary').value.trim(),
          status: $('qf-status').value,
          route: $('qf-route').value.trim(),
        },
      });
      $('queue-form').reset();
      $('qf-originalId').value = '';
      delete $('qf-route').dataset.userEdited;
      $('qf-route').value = `L2 ${state.snap?.settings?.effective?.l2StandardModel || 'Orchestrator (Neon)'}`;
      render(res.snapshot);
      showToast('已保存调度任务');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('qf-reset-btn').addEventListener('click', () => {
    $('queue-form').reset();
    $('qf-originalId').value = '';
    delete $('qf-route').dataset.userEdited;
    $('qf-route').value = `L2 ${state.snap?.settings?.effective?.l2StandardModel || 'Orchestrator (Neon)'}`;
  });

  $('raw-editor').addEventListener('input', () => {
    state.rawDirty = true;
  });

  $('save-raw-btn').addEventListener('click', async () => {
    try {
      const res = await api('/api/registry/save', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          relPath: state.snap.registryRelPath,
          expectedHash: state.snap.hash,
          content: $('raw-editor').value,
        },
      });
      state.rawDirty = false;
      $('conflict-banner').classList.add('hidden');
      render(res.snapshot);
      showToast('台账已保存');
    } catch (err) {
      if (err.status === 409) {
        $('conflict-banner').classList.remove('hidden');
      }
      showToast(err.message, true);
    }
  });

  $('reset-raw-btn').addEventListener('click', () => {
    state.rawDirty = false;
    $('raw-editor').value = state.snap?.content || '';
    $('conflict-banner').classList.add('hidden');
  });

  $('reload-latest-btn').addEventListener('click', () => refresh());

  if (window.sidecar?.onWorkspaceChange) {
    window.sidecar.onWorkspaceChange((uris) => {
      if (Array.isArray(uris) && uris.length > 0) {
        refresh(uris[0], { recordSelection: true });
      } else {
        refresh('');
      }
    });
  } else {
    refresh('');
  }
