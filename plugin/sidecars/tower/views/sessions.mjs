import {
  escHtml as esc,
  formatIsolationLabel,
  summarizeExecutionSurfaces,
} from '../ui-logic.mjs';

export function renderSessions(ctx, snap) {
  const { $ } = ctx;
  const eff = snap.settings?.effective || {};
  const leaseEnabled = eff.exclusiveLeaseEnabled !== false;
  $('df-lock-wrap').classList.toggle('hidden', !leaseEnabled);
  if (!$('df-model').dataset.userEdited) {
    $('df-model').value = eff.l2StandardModel || 'Orchestrator (Neon Extra High)';
  }

  // 4-Surface Unified Task Navigator
  const surfaces = snap.executionSurfaces || {
    swarm: snap.nativeSwarm,
    subagents: [],
    workflows: [],
    topLevel: snap.parsed?.activeSessions || [],
  };
  const surfSum = summarizeExecutionSurfaces(surfaces);
  const policyLabel =
    eff.dispatchSurfacePolicy === 'slot_reuse'
      ? '固定槽位复用'
      : eff.dispatchSurfacePolicy === 'allow_toplevel'
        ? '允许常规顶层'
        : '隐藏面优先';
  $('surfaces-summary-badge').textContent = `${policyLabel} | 隐藏 ${surfSum.hiddenTotal}`;
  $('surfaces-grid').innerHTML = [
    ['Swarm 隐藏成员', surfSum.swarm, 'badge-ok'],
    ['Subagent 子代理', surfSum.subagents, 'badge-muted'],
    ['Workflow 流水线', surfSum.workflows, 'badge-muted'],
    ['顶层侧栏会话', surfSum.topLevel, surfSum.sidebarWarning ? 'badge-warn' : 'badge-muted'],
  ]
    .map(
      ([label, count, cls]) =>
        `<div class="surface-pill"><span>${esc(label)}</span><span class="badge ${cls}"><strong>${esc(count)}</strong></span></div>`
    )
    .join('');
  $('sidebar-hint').classList.toggle('hidden', !surfSum.sidebarWarning);

  // Native Swarm panel with workspace isolation badge + cleanup waiting members button
  const swarm = snap.nativeSwarm || { active: false, members: [], recentPosts: [] };
  const swarmCard = $('swarm-card');
  swarmCard.classList.toggle('hidden', !swarm.active);
  if (swarm.active) {
    const waitingCount = (swarm.members || []).filter((m) => m.state === 'waiting').length;
    $('swarm-cleanup-btn').classList.toggle('hidden', waitingCount === 0);
    $('swarm-cleanup-btn').textContent = `回收休眠成员 (${waitingCount})`;
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
              <div class="actions">
                <span class="badge badge-muted">${esc(formatIsolationLabel(m.workspace || 'inherit'))}</span>
                <span class="badge ${stCls}">${esc(m.state)}</span>
              </div>
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
            .map((p) => `<div class="item-meta">#${esc(p.seq)} [${esc(p.agent)}]: ${esc(p.text)}</div>`)
            .join('');
  }

  // Hidden Subagents & Workflows card
  const subs = Array.isArray(surfaces.subagents) ? surfaces.subagents : [];
  const wfs = Array.isArray(surfaces.workflows) ? surfaces.workflows : [];
  const hasHiddenOther = subs.length > 0 || wfs.length > 0;
  $('hidden-surfaces-card').classList.toggle('hidden', !hasHiddenOther);
  if (hasHiddenOther) {
    $('hidden-surfaces-badge').textContent = `子代理 ${subs.length} | 流水线 ${wfs.length}`;
    $('subagents-list').innerHTML = subs
      .map(
        (sub) => `
        <div class="item-box">
          <div class="card-head">
            <strong>[Subagent] ${esc(sub.role)} (${esc(sub.typeName)})</strong>
            <span class="badge badge-muted">${esc(sub.status)}</span>
          </div>
          <div class="item-meta">模型: ${esc(sub.model)} | 隔离: ${esc(sub.workspace)} | 步数: ${esc(sub.steps)}</div>
          ${
            sub.conversationId
              ? `<div class="actions">
                  <button class="btn btn-ghost btn-sm jump-conv-btn" data-id="${esc(sub.conversationId)}">跳转子代理</button>
                  <button class="btn btn-ghost btn-sm copy-conv-btn" data-id="${esc(sub.conversationId)}">复制 ID</button>
                </div>`
              : ''
          }
        </div>
      `
      )
      .join('');
    $('workflows-list').innerHTML = wfs
      .map(
        (wf) => `
        <div class="item-box">
          <div class="card-head">
            <strong>[Workflow] ${esc(wf.description)}</strong>
            <span class="badge badge-muted">${esc(wf.status)}</span>
          </div>
          <div class="item-meta">脚本: ${esc(wf.scriptPath)} | 步序: #${esc(wf.stepIndex)}</div>
        </div>
      `
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
              <button class="btn btn-ghost btn-sm send-learn-btn" data-id="${esc(s.conversationId)}">发送 /learn</button>
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

export function renderQueue(ctx, snap) {
  const { $ } = ctx;
  const queue = snap.parsed?.queue || [];
  const eff = snap.settings?.effective || {};
  if (!$('qf-originalId').value && !$('qf-route').dataset.userEdited) {
    $('qf-route').value = `L2 ${eff.l2StandardModel || 'Gemini 4 Neon (High)'}`;
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

export function renderRaw(ctx, snap) {
  const { $, state } = ctx;
  $('raw-hash-badge').textContent = snap.hash ? snap.hash.slice(0, 10) : '-';
  const tplSrc = snap.settings?.docs?.['templates.md']?.source || 'builtin';
  $('tpl-source-badge').textContent = tplSrc;
  if (!state.rawDirty) {
    $('raw-editor').value = snap.content || '';
    state.rawBaseHash = snap.hash || '';
  } else if (snap.hash && state.rawBaseHash && snap.hash !== state.rawBaseHash) {
    $('conflict-banner')?.classList.remove('hidden');
  }
}

export function openInlineArchiveForm(ctx, convId, topic) {
  const { $ } = ctx;
  $('af-convId').value = convId;
  $('af-title').textContent = `归档会话 ${convId.slice(0, 8)} 至第 4 节里程碑`;
  $('af-milestone').value = topic || '已完成里程碑';
  $('af-summary').value = '已完成验证并收口';
  $('archive-form').classList.remove('hidden');
  $('af-summary').focus();
}

export function bindSessionsAndQueueEvents(ctx) {
  const { $, state, api, render, showToast, withBusyButton, copyText, refresh } = ctx;

  $('toggle-dispatch-btn').addEventListener('click', () => $('dispatch-form').classList.toggle('hidden'));
  $('df-model').addEventListener('input', () => {
    $('df-model').dataset.userEdited = '1';
  });
  $('df-clear-ws-btn').addEventListener('click', () => {
    $('df-workstreamId').value = '';
    $('df-workstream-note').classList.add('hidden');
    delete $('df-model').dataset.userEdited;
  });

  $('dispatch-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = $('dispatch-form').querySelector('button[type="submit"]');
    await withBusyButton(submitBtn, async () => {
      try {
        const wsId = $('df-workstreamId').value.trim();
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
            workstreamId: wsId || undefined,
          },
        });
        $('df-topic').value = '';
        $('df-prompt').value = '';
        $('df-workstreamId').value = '';
        $('df-slash').value = '';
        $('df-lock').selectedIndex = 0;
        delete $('df-model').dataset.userEdited;
        $('df-workstream-note').classList.add('hidden');
        render(res.snapshot);
        showToast(
          res.conversationId
            ? `已拉起专职会话 ${res.conversationId.slice(0, 8)}${res.enrolled ? ' 并入账' : ''}`
            : '已拉起专职会话'
        );
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  $('df-copy-btn').addEventListener('click', async () => {
    const tpl = state.snap?.templates?.dispatchOfflineTemplate || '';
    const topic = $('df-topic').value.trim() || '<唯一目标>';
    const prompt = $('df-prompt').value.trim() || '<验证判据>';
    const prefix = $('df-slash').value ? `${$('df-slash').value} ` : '';
    const ctrlId = state.snap?.parsed?.controller?.currentControllerId || '<controllerId>';
    const filled = `${prefix}${tpl
      .replace('<编号> - <唯一目标>', topic)
      .replace('<编号> — <唯一目标>', topic)
      .replace('<controllerId>', ctrlId)}\n\n补充需求说明：${prompt}`;
    const ok = await copyText(filled);
    showToast(ok ? '已复制直派兜底开场词' : '复制失败', !ok);
  });

  $('swarm-cleanup-btn').addEventListener('click', () =>
    withBusyButton($('swarm-cleanup-btn'), async () => {
      if (!state.workspace) return;
      try {
        const res = await api('/api/swarm/cleanup-request', {
          method: 'POST',
          body: { workspace: state.workspace },
        });
        render(res.snapshot);
        showToast(
          res.requested?.length > 0
            ? `已通知总控核查并回收 ${res.requested.length} 个休眠成员`
            : '当前无休眠 Swarm 成员'
        );
      } catch (err) {
        showToast(err.message, true);
      }
    })
  );

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

  // Native inline archive form (replaces WebView-blocked window.prompt)
  $('cancel-archive-form-btn').addEventListener('click', () => {
    $('archive-form').classList.add('hidden');
  });

  $('archive-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const convId = $('af-convId').value.trim();
    if (!convId) return;
    try {
      const res = await api('/api/sessions/archive', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          relPath: state.snap.registryRelPath,
          expectedHash: state.snap.hash,
          conversationId: convId,
          milestone: $('af-milestone').value.trim() || '已完成里程碑',
          summary: $('af-summary').value.trim() || '已完成验证并收口',
        },
      });
      $('archive-form').classList.add('hidden');
      render(res.snapshot);
      showToast(`已归档会话 ${convId.slice(0, 8)}`);
    } catch (err) {
      if (err.status === 409) $('conflict-banner').classList.remove('hidden');
      showToast(err.message, true);
    }
  });

  const runProbe = async () => {
    const id = $('probe-id-input').value.trim();
    if (!id) return;
    const seq = ++state.probeSeq;
    const box = $('probe-result');
    box.classList.remove('hidden');
    try {
      const data = await api(`/api/session/inspect?id=${encodeURIComponent(id)}`);
      if (seq !== state.probeSeq) return;
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
          <button type="button" class="btn btn-primary btn-sm enroll-probe-btn">一键入账活跃表</button>
          <button type="button" class="btn btn-ghost btn-sm notify-ctrl-btn" data-id="${esc(data.conversationId)}">投递裸 ID 给总控</button>
          <button type="button" class="btn btn-ghost btn-sm jump-conv-btn" data-id="${esc(data.conversationId)}">跳转会话</button>
        </div>
      `;
    } catch (err) {
      if (seq === state.probeSeq) {
        box.innerHTML = `<div class="item-meta">${esc(err.message)}</div>`;
      }
    }
  };
  $('probe-btn').addEventListener('click', runProbe);
  $('probe-id-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runProbe();
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
      $('qf-route').value = `L2 ${state.snap?.settings?.effective?.l2StandardModel || 'Gemini 4 Neon (High)'}`;
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
    $('qf-route').value = `L2 ${state.snap?.settings?.effective?.l2StandardModel || 'Gemini 4 Neon (High)'}`;
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
          expectedHash: state.rawBaseHash || state.snap.hash,
          content: $('raw-editor').value,
        },
      });
      state.rawDirty = false;
      state.rawBaseHash = res.snapshot?.hash || '';
      $('conflict-banner').classList.add('hidden');
      render(res.snapshot);
      showToast('台账已保存');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('reset-raw-btn').addEventListener('click', () => {
    state.rawDirty = false;
    state.rawBaseHash = state.snap?.hash || '';
    $('raw-editor').value = state.snap?.content || '';
    $('conflict-banner').classList.add('hidden');
  });

  $('reload-latest-btn').addEventListener('click', () => refresh());
}
