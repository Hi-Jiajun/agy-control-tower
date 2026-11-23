import {
  escHtml as esc,
  formatCollabLabel,
  formatIsolationLabel,
  formatRoadmapStatusBadge,
} from '../ui-logic.mjs';

export function renderRoadmap(ctx, snap) {
  const { $, state } = ctx;
  const rm = snap.roadmap || { exists: false };
  $('rm-empty').classList.toggle('hidden', Boolean(rm.exists));
  $('rm-body').classList.toggle('hidden', !rm.exists);
  if (!rm.exists) return;

  $('rm-storage-badge').textContent = rm.isManaged ? '@plugin_data 托管' : '.agents/ 工作区';
  if (!state.rmL1Dirty && document.activeElement !== $('rm-l1-editor')) {
    $('rm-l1-editor').value = rm.l1Content || '';
    state.rmL1BaseHash = rm.l1Hash || '';
  }

  const graph = rm.graph || {
    milestoneStats: [],
    overlaps: [],
    nodes: [],
    counts: { total: 0, done: 0, ready: 0 },
  };
  const msBox = $('rm-milestones-list');
  if (graph.milestoneStats.length === 0) {
    msBox.innerHTML = '<p class="muted">暂无里程碑记录</p>';
  } else {
    msBox.innerHTML = graph.milestoneStats
      .map((m) => {
        const pct = Math.min(100, Math.max(0, Number(m.pct) || 0));
        return `
        <div class="item-box">
          <div class="card-head">
            <strong>${esc(m.id)} | ${esc(m.title)}</strong>
            <span class="badge ${pct === 100 ? 'badge-ok' : 'badge-muted'}">${esc(m.done)}/${esc(m.total)} (${esc(pct)}%)</span>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
          <div class="item-meta">DoD: ${esc(m.dod)} | 就绪 ${esc(m.ready)} / 进行中 ${esc(m.active)} / 阻塞 ${esc(m.blocked)}</div>
        </div>
      `;
      })
      .join('');
  }

  const overlaps = graph.overlaps || [];
  $('rm-overlap-banner').classList.toggle('hidden', overlaps.length === 0);
  if (overlaps.length > 0) {
    $('rm-overlap-text').textContent = `所有权冲突预警 (${overlaps.length} 组): ${overlaps
      .map((o) => `${o.nodeA}/${o.nodeB} [${o.paths.join(', ')}]`)
      .join('；')}`;
  }

  $('rm-nodes-badge').textContent = `${graph.counts.done}/${graph.counts.total} | 就绪 ${graph.counts.ready}`;
  const nodesBox = $('rm-nodes-list');
  if (graph.nodes.length === 0) {
    nodesBox.innerHTML = '<p class="muted">暂无分支工作包，点击右上角「新增分支」开始渐进式细化。</p>';
    return;
  }
  nodesBox.innerHTML = graph.nodes
    .map((n) => {
      const st = formatRoadmapStatusBadge(n.effectiveStatus);
      const depsLine =
        n.unmetDeps?.length > 0
          ? `阻塞前置: ${n.unmetDeps.join(', ')}`
          : n.dependsOn?.length > 0
            ? `前置已满足: ${n.dependsOn.join(', ')}`
            : '无前置依赖';
      const ownLine = n.ownership?.length > 0 ? n.ownership.join(', ') : '未限定';
      const isDone = n.status === 'done' || n.status === 'verified';
      const isBlocked = n.effectiveStatus === 'blocked';
      const hf = n.handoff || { exists: false };
      const handoffBlock = hf.exists
        ? `
          <details class="handoff-details">
            <summary>接力契约已落盘: ${esc(hf.relPath)} (${esc(hf.bytes)}B)</summary>
            <pre class="handoff-preview">${esc(hf.preview)}</pre>
          </details>
        `
        : '';
      return `
        <div class="item-box">
          <div class="card-head">
            <strong>${esc(n.id)} | ${esc(n.title)}</strong>
            <span class="badge ${st.badgeClass}">${esc(st.text)}</span>
          </div>
          <div class="item-meta">${esc(n.milestoneId)} / ${esc(n.epic)} | ${esc(formatIsolationLabel(n.isolation))} | ${esc(formatCollabLabel(n.collaboration))}</div>
          <div class="item-meta">所有权: ${esc(ownLine)} | ${esc(depsLine)}</div>
          <div class="item-meta">验收: ${esc(n.acceptance || '-')} | 模型: ${esc(n.recommendedModel || '-')}</div>
          ${handoffBlock}
          <div class="actions">
            ${!isDone ? `<button type="button" class="btn btn-primary btn-sm rm-dispatch-hidden-btn" data-id="${esc(n.id)}" ${isBlocked ? 'disabled title="前置依赖未完成，暂不可直接派单"' : ''}>交总控隐藏面派单</button>` : ''}
            ${!isDone ? `<button type="button" class="btn btn-ghost btn-sm rm-fill-dispatch-btn" data-id="${esc(n.id)}">填入白名单直派</button>` : ''}
            <button type="button" class="btn btn-ghost btn-sm rm-copy-contract-btn" data-id="${esc(n.id)}">复制契约词</button>
            ${!isDone ? `<button type="button" class="btn btn-ghost btn-sm rm-mark-done-btn" data-id="${esc(n.id)}">标记完成</button>` : ''}
            ${n.linkedConvId ? `<button type="button" class="btn btn-ghost btn-sm jump-conv-btn" data-id="${esc(n.linkedConvId)}">跳转会话</button>` : ''}
            <button type="button" class="btn btn-ghost btn-sm rm-edit-node-btn" data-id="${esc(n.id)}">编辑</button>
            <button type="button" class="btn btn-danger btn-sm rm-del-node-btn" data-id="${esc(n.id)}">删除</button>
          </div>
        </div>
      `;
    })
    .join('');
}

export function bindRoadmapEvents(ctx) {
  const { $, state, api, render, showToast } = ctx;

  $('rm-init-ws-btn').addEventListener('click', async () => {
    if (!state.workspace) return;
    try {
      const res = await api('/api/roadmap/init', {
        method: 'POST',
        body: { workspace: state.workspace, storageMode: 'workspace' },
      });
      render(res.snapshot);
      showToast('已初始化工作区三层路线图 (.agents/)');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('rm-init-managed-btn').addEventListener('click', async () => {
    if (!state.workspace) return;
    try {
      const res = await api('/api/roadmap/init', {
        method: 'POST',
        body: { workspace: state.workspace, storageMode: 'plugin_data' },
      });
      render(res.snapshot);
      showToast('已初始化零侵入托管路线图 (@plugin_data/)');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('rm-l1-editor').addEventListener('input', () => {
    state.rmL1Dirty = true;
  });
  $('rm-toggle-l1-btn').addEventListener('click', () => $('rm-l1-wrap').classList.toggle('hidden'));
  $('rm-toggle-ms-form-btn').addEventListener('click', () => $('rm-ms-form').classList.toggle('hidden'));
  $('rm-ms-cancel-btn').addEventListener('click', () => $('rm-ms-form').classList.add('hidden'));
  $('rm-toggle-node-form-btn').addEventListener('click', () => {
    const formEl = $('rm-node-form');
    const wasHidden = formEl.classList.contains('hidden');
    const wasEditing = Boolean($('rnf-originalId').value);
    if (wasHidden || wasEditing) {
      formEl.reset();
      $('rnf-originalId').value = '';
      formEl.classList.remove('hidden');
    } else {
      formEl.classList.add('hidden');
    }
  });
  $('rm-node-cancel-btn').addEventListener('click', () => {
    $('rm-node-form').reset();
    $('rnf-originalId').value = '';
    $('rm-node-form').classList.add('hidden');
  });

  $('rm-l1-save-btn').addEventListener('click', async () => {
    if (!state.workspace) return;
    try {
      const res = await api('/api/roadmap/l1/save', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          content: $('rm-l1-editor').value,
          expectedL1Hash: state.rmL1BaseHash || state.snap?.roadmap?.l1Hash || '',
        },
      });
      state.rmL1Dirty = false;
      state.rmL1BaseHash = res.snapshot?.roadmap?.l1Hash || '';
      render(res.snapshot);
      showToast('已保存 L1 战略北极星 ROADMAP.md');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('rm-ms-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.workspace) return;
    try {
      const res = await api('/api/roadmap/milestone/upsert', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          expectedL2Hash: state.snap?.roadmap?.l2Hash || '',
          id: $('rms-id').value.trim(),
          title: $('rms-title').value.trim(),
          dod: $('rms-dod').value.trim(),
          status: $('rms-status').value,
        },
      });
      $('rm-ms-form').reset();
      $('rm-ms-form').classList.add('hidden');
      render(res.snapshot);
      showToast('已保存阶段里程碑');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('rm-node-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.workspace) return;
    try {
      const origId = $('rnf-originalId').value;
      const res = await api('/api/roadmap/node/upsert', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          expectedL2Hash: state.snap?.roadmap?.l2Hash || '',
          originalId: origId || undefined,
          requireNew: !origId,
          id: $('rnf-id').value.trim(),
          milestoneId: $('rnf-milestoneId').value.trim() || 'M1',
          title: $('rnf-title').value.trim(),
          epic: $('rnf-epic').value.trim() || 'Core',
          status: $('rnf-status').value,
          isolation: $('rnf-isolation').value,
          collaboration: $('rnf-collaboration').value,
          dependsOn: $('rnf-dependsOn').value.trim(),
          ownership: $('rnf-ownership').value.trim(),
          recommendedModel: $('rnf-model').value.trim(),
          acceptance: $('rnf-acceptance').value.trim(),
        },
      });
      $('rm-node-form').reset();
      $('rnf-originalId').value = '';
      $('rm-node-form').classList.add('hidden');
      render(res.snapshot);
      showToast('已保存路线图分支节点');
    } catch (err) {
      showToast(err.message, true);
    }
  });
}
