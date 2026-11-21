(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const uiToken = params.get('token') || '';

  const state = {
    tab: 'overview',
    workspace: '',
    snap: null,
    toastTimer: null,
    rawDirty: false,
    lastProbe: null,
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

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  function showToast(msg, isErr = false) {
    const el = $('toast');
    el.textContent = msg;
    el.className = isErr ? 'toast error' : 'toast';
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
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

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    ['overview', 'sessions', 'queue', 'raw'].forEach((name) => {
      const panel = $(`tab-${name}`);
      panel.classList.toggle('hidden', !state.snap?.registryExists || name !== tab);
    });
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
      relBadge.textContent = snap.registryRelPath;
      relBadge.classList.remove('hidden');
    } else {
      relBadge.classList.add('hidden');
    }
  }

  function renderOverview(snap) {
    const lease = snap.parsed?.lease || {};
    const statusText = lease.lockStatus || '-';
    const pill = $('lease-status-pill');
    pill.textContent = statusText;
    const isIdle = /IDLE|空闲|无独占/i.test(statusText);
    pill.className = `badge ${isIdle ? 'badge-ok' : 'badge-warn'}`;

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

    const ctrl = snap.parsed?.controller || {};
    const tel = ctrl.telemetry || {};
    const comps = Number(tel.compactions || 0);
    const compBadge = $('ctrl-comp-badge');
    compBadge.textContent = `压缩 ${comps} 次`;
    compBadge.className = `badge ${comps >= 2 ? 'badge-danger' : 'badge-ok'}`;
    $('ctrl-alert').classList.toggle('hidden', comps < 2);

    const stepStr = tel.exists ? `${tel.maxStepIndex || tel.lineCount} 步 (${tel.lineCount} 条)` : '未定位到日志';
    $('ctrl-view').innerHTML = [
      ['总控 ID', ctrl.currentControllerId || '未登记'],
      ['常驻模型', ctrl.defaultModel || '-'],
      ['运行状态', `${ctrl.currentControllerStatus || '-'} | ${tel.lastModel || '-'}`],
      ['日志进度', `${stepStr}${tel.lastUpdatedAt ? ` | ${tel.lastUpdatedAt}` : ''}`],
    ]
      .map(([k, v]) => `<div class="kv-k">${esc(k)}</div><div class="kv-v">${esc(v)}</div>`)
      .join('');

    $('cf-controllerId').value = ctrl.currentControllerId || window.sidecar?.conversationId || '';
    $('cf-status').value = ctrl.currentControllerStatus || 'ONLINE';
    $('cf-defaultModel').value = ctrl.defaultModel || 'Orchestrator (Neon)';
  }

  function renderSessions(snap) {
    const active = snap.parsed?.activeSessions || [];
    $('active-count-badge').textContent = String(active.length);
    const activeBox = $('active-sessions-list');
    if (active.length === 0) {
      activeBox.innerHTML = '<p class="muted">暂无活跃或挂起专职会话</p>';
    } else {
      activeBox.innerHTML = active
        .map((s) => {
          const t = s.telemetry || {};
          const compWarn = t.compactions >= 2 ? 'badge-danger' : 'badge-muted';
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
    if (!state.rawDirty) {
      $('raw-editor').value = snap.content || '';
    }
  }

  function render(snap) {
    state.snap = snap;
    $('version-badge').textContent = `v${snap.plugin?.version || '1.1.0'}`;
    renderWorkspaces(snap);

    const hasReg = Boolean(snap.registryExists);
    $('empty-state').classList.toggle('hidden', hasReg || !snap.workspace);
    $('empty-ws-path').textContent = snap.workspace ? `当前工作区: ${snap.workspace}` : '';
    switchTab(state.tab);

    if (hasReg) {
      renderOverview(snap);
      renderSessions(snap);
      renderQueue(snap);
      renderRaw(snap);
    }
  }

  async function refresh(wsOverride, { recordSelection = false } = {}) {
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
      state.rawDirty = false;
      $('conflict-banner').classList.add('hidden');
      render(snap);
    } catch (err) {
      showToast(err.message, true);
    }
  }

  function buildPrefilledHandover() {
    const snap = state.snap;
    const raw = snap?.templates?.handoverTemplate || '';
    if (!snap || !snap.registryExists) return raw;
    const ctrl = snap.parsed?.controller || {};
    const nextTerm = (ctrl.handoverHistory?.length || 0) + 1;
    const lease = snap.parsed?.lease || {};
    const activeText =
      (snap.parsed?.activeSessions || [])
        .slice(0, 3)
        .map((s) => `${s.conversationId} (${s.topic})`)
        .join('; ') || '无';
    return raw
      .replace('<N>', String(nextTerm))
      .replace('<旧 conversationId>', ctrl.currentControllerId || '<旧 conversationId>')
      .replace('<列出 AGENTS.md / 状态总账 / SESSION-REGISTRY.md 精确路径>', snap.registryRelPath || 'SESSION-REGISTRY.md')
      .replace('<无独占资源 / IDLE / 会话 conversationId（任务编号）>', `${lease.lockStatus || 'IDLE'} | ${lease.holder || '-'}`)
      .replace('<1~3 条仍在推进的 conversationId 与停靠点，没有填 无>', activeText);
  }

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('refresh-btn').addEventListener('click', () => refresh());
  $('ws-select').addEventListener('change', (e) => {
    if (e.target.value) refresh(e.target.value, { recordSelection: true });
  });

  $('init-registry-btn').addEventListener('click', async () => {
    if (!state.workspace) return;
    try {
      const res = await api('/api/registry/init', {
        method: 'POST',
        body: { workspace: state.workspace, relPath: $('init-relpath').value },
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

  document.body.addEventListener('click', async (e) => {
    const enrollBtn = e.target.closest('.enroll-probe-btn');
    if (enrollBtn && state.lastProbe?.status === 'ok') {
      const p = state.lastProbe;
      const info = p.info || {};
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
            lockStatus: '纯离线无锁',
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
      $('qf-route').value = 'L2 Orchestrator (Neon)';
      render(res.snapshot);
      showToast('已保存调度任务');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('qf-reset-btn').addEventListener('click', () => {
    $('queue-form').reset();
    $('qf-originalId').value = '';
    $('qf-route').value = 'L2 Orchestrator (Neon)';
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
})();
