import {
  buildPrefilledHandoverText,
  computeControllerHealth,
  computeOverviewRestraint,
  escHtml as esc,
  formatFocusGateBadge,
  formatGlobalWorkspacesBadge,
  formatInboxPriorityClass,
  isLeaseIdle,
} from '../ui-logic.mjs';

export function renderGlobalWorkspacesDrawer(ctx, snap, { forceList = false } = {}) {
  const { $, setHtmlIfChanged } = ctx;
  const mw = snap?.multiWorkspace || { workspaceCount: 0, totalP0: 0, totalP1: 0, workspaces: [] };
  const badgeInfo = formatGlobalWorkspacesBadge(mw);
  const badgeEl = $('global-ws-badge');
  if (badgeEl) {
    badgeEl.textContent = badgeInfo.text;
    badgeEl.className = `badge ${badgeInfo.badgeClass}`;
  }

  const drawerEl = $('global-ws-drawer');
  if (!forceList && drawerEl?.classList.contains('hidden')) return;

  const box = $('global-ws-list');
  if (!box) return;
  const list = Array.isArray(mw.workspaces) ? mw.workspaces : [];
  if (list.length === 0) {
    setHtmlIfChanged(box, '<p class="empty-inline">暂无已记录的工作区。</p>');
    return;
  }
  const html = list
    .map((w) => {
      const uc = w.unreadCounts || { P0: 0, P1: 0, P2: 0, total: 0 };
      const inboxCls =
        uc.P0 > 0 ? 'badge-danger' : uc.P1 > 0 ? 'badge-warn' : 'badge-muted';
      const leaseCls = w.registryExists ? (w.leaseIdle ? 'badge-ok' : 'badge-warn') : 'badge-muted';
      const ctrlText = w.controllerId ? w.controllerId.slice(0, 8) : '未登记';
      const rmText = w.roadmapExists ? `${w.roadmapDone}/${w.roadmapTotal} (就绪 ${w.roadmapReady})` : '未建';
      return `
        <div class="item-box">
          <div class="card-head">
            <strong>${esc(w.shortName)}${w.isCurrent ? ' (当前)' : ''}</strong>
            <div class="actions">
              <span class="badge ${leaseCls}">${esc(w.leaseIdle ? '锁空闲' : '持锁中')}</span>
              <span class="badge ${inboxCls}">P0:${esc(uc.P0)} P1:${esc(uc.P1)}</span>
            </div>
          </div>
          <div class="item-meta">总控: ${esc(ctrlText)} | 活跃会话: ${esc(w.activeSessionCount)} | 路线图: ${esc(rmText)}</div>
          <div class="actions">
            ${
              !w.isCurrent
                ? `<button type="button" class="btn btn-primary btn-sm switch-ws-card-btn" data-ws="${esc(w.workspace)}">切换至此工作区</button>`
                : ''
            }
            ${
              w.controllerId
                ? `<button type="button" class="btn btn-ghost btn-sm jump-conv-btn" data-id="${esc(w.controllerId)}">跳转总控</button>`
                : ''
            }
          </div>
        </div>
      `;
    })
    .join('');
  setHtmlIfChanged(box, html);
}

export function renderAttentionBanner(ctx, snap) {
  const { $ } = ctx;
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
          <button class="btn btn-ghost btn-sm dismiss-att-btn" data-kind="handover" data-id="${esc(item.id)}" data-ctrl="${esc(ctrlId)}">本会话忽略</button>
        `
        : `
          <button class="btn btn-primary btn-sm jump-conv-btn" data-id="${esc(ctrlId)}">跳转总控拍板</button>
          <button class="btn btn-ghost btn-sm dismiss-att-btn" data-id="${esc(item.id)}">已处理</button>
        `;
      return `
        <div class="attention-item">
          <span>${esc(item.summary || item.title || item.kind)}</span>
          <div class="actions">${actionBtns}</div>
        </div>
      `;
    })
    .join('');
}

export function renderOverview(ctx, snap) {
  const { $, setModelField, setHtmlIfChanged } = ctx;
  const eff = snap.settings?.effective || {};
  const leaseEnabled = eff.exclusiveLeaseEnabled !== false;
  const lease = snap.parsed?.lease || {};
  const statusText = leaseEnabled ? lease.lockStatus || '-' : '无独占资源模式';
  const inbox = snap.inbox || {
    focus: { mode: 'idle' },
    unreadCounts: { P0: 0, P1: 0, P2: 0, total: 0 },
    items: [],
  };
  const uc = inbox.unreadCounts || { P0: 0, P1: 0, P2: 0, total: 0 };
  const restraint = computeOverviewRestraint({
    leaseEnabled,
    lockStatus: statusText,
    unreadTotal: uc.total || 0,
  });

  const pill = $('lease-status-pill');
  pill.textContent = statusText;
  const isIdle = isLeaseIdle(statusText, leaseEnabled);
  pill.className = `badge ${isIdle ? 'badge-ok' : 'badge-warn'}`;

  $('release-lease-btn')?.classList.toggle('hidden', !restraint.showReleaseLeaseBtn);
  $('lease-disabled-note').classList.toggle('hidden', leaseEnabled);
  $('lease-active-wrap').classList.toggle('hidden', !leaseEnabled);

  if (leaseEnabled) {
    $('lease-idle-summary')?.classList.toggle('hidden', restraint.showFullLeaseGrid);
    $('lease-view')?.classList.toggle('hidden', !restraint.showFullLeaseGrid);
    setHtmlIfChanged(
      $('lease-view'),
      [
        ['锁状态', lease.lockStatus || '-'],
        ['持锁会话', lease.holder || '-'],
        ['独占对象', lease.resource || '-'],
        ['起始时间', lease.since || '-'],
        ['操作范围', lease.scope || '-'],
        ['解锁判据', lease.releaseCriteria || '-'],
      ]
        .map(([k, v]) => `<div class="kv-k">${esc(k)}</div><div class="kv-v">${esc(v)}</div>`)
        .join('')
    );

    if ($('lease-form').classList.contains('hidden')) {
      $('lf-lockStatus').value = lease.lockStatus || '';
      $('lf-holder').value = lease.holder || '-';
      $('lf-resource').value = lease.resource || '-';
      $('lf-since').value = lease.since || '-';
      $('lf-scope').value = lease.scope || '-';
      $('lf-releaseCriteria').value = lease.releaseCriteria || '-';
    }
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
  autoBadge.textContent = `代决策: ${eff.effectiveAutonomy || 'balanced'}`;

  const cleanCtrlModel = String(ctrl.defaultModel || eff.l0ControllerModel || '-')
    .replace(/^`+|`+$/g, '')
    .trim();
  const stepStr = tel.exists ? `${tel.maxStepIndex || tel.lineCount} 步 (${tel.lineCount} 条)` : '未定位到日志';
  const ctrlStatusUpper = String(ctrl.currentControllerStatus || '').toUpperCase();
  const statusDotCls =
    ctrlStatusUpper === 'ONLINE' ? 'online' : ctrlStatusUpper === 'HANDOVER' ? 'warn' : '';
  const statusHtml = `<span class="status-dot-inline ${statusDotCls}"></span>${esc(ctrl.currentControllerStatus || '-')} | ${esc(tel.lastModel || '-')}`;
  setHtmlIfChanged(
    $('ctrl-view'),
    [
      ['总控 ID', esc(ctrl.currentControllerId || '未登记')],
      ['常驻模型', esc(cleanCtrlModel || '-')],
      ['运行状态', statusHtml],
      ['日志进度', esc(`${stepStr}${tel.lastUpdatedAt ? ` | ${tel.lastUpdatedAt}` : ''}`)],
    ]
      .map(([k, vHtml]) => `<div class="kv-k">${esc(k)}</div><div class="kv-v">${vHtml}</div>`)
      .join('')
  );

  if ($('ctrl-form').classList.contains('hidden')) {
    $('cf-controllerId').value = ctrl.currentControllerId || window.sidecar?.conversationId || '';
    $('cf-status').value = ctrl.currentControllerStatus || 'ONLINE';
    setModelField(
      'cf-defaultModel',
      cleanCtrlModel && cleanCtrlModel !== '-' ? cleanCtrlModel : 'Gemini 4 Neon (XHigh)'
    );
  }

  // Zero-token Sentinel & Priority Inbox
  const focusBadge = formatFocusGateBadge(inbox.focus);
  const fbEl = $('inbox-focus-badge');
  fbEl.textContent = focusBadge.text;
  fbEl.className = `badge ${focusBadge.badgeClass}`;

  const totalUnread = Number(uc.total || 0);
  $('inbox-counts-badge').textContent =
    totalUnread > 0
      ? `未读 ${totalUnread} (P0:${uc.P0 || 0} P1:${uc.P1 || 0} P2:${uc.P2 || 0})`
      : '未读 0';
  $('inbox-counts-badge').className = `badge ${
    (uc.P0 || 0) > 0 ? 'badge-danger' : (uc.P1 || 0) > 0 ? 'badge-warn' : 'badge-muted'
  }`;

  const deliverAllBtn = $('inbox-deliver-all-btn');
  if (deliverAllBtn) {
    deliverAllBtn.disabled = !restraint.canDeliverInbox;
    deliverAllBtn.classList.toggle('btn-primary', restraint.canDeliverInbox);
    deliverAllBtn.classList.toggle('btn-ghost', !restraint.canDeliverInbox);
  }
  $('inbox-ack-all-btn')?.classList.toggle('hidden', !restraint.canAckAllInbox);

  const inboxList = $('inbox-list');
  const items = Array.isArray(inbox.items) ? inbox.items.slice(0, 12) : [];
  if (items.length === 0) {
    setHtmlIfChanged(inboxList, '<p class="empty-inline">哨兵巡检正常，暂无待处理后台事件。</p>');
  } else {
    setHtmlIfChanged(
      inboxList,
      items
        .map((it) => {
          const pCls = formatInboxPriorityClass(it.priority);
          return `
            <div class="item-box ${it.acked ? 'inbox-row-acked' : ''}">
              <div class="card-head">
                <strong>${esc(it.title || it.kind)}</strong>
                <span class="badge ${pCls}">${esc(it.priority)}${it.acked ? ' 已读' : ''}</span>
              </div>
              <div class="item-meta">${esc(it.summary || '-')}</div>
              ${
                !it.acked
                  ? `<div class="actions">
                      <button class="btn btn-ghost btn-xs inbox-deliver-btn" data-id="${esc(it.id)}">投递</button>
                      <button class="btn btn-ghost btn-xs inbox-ack-btn" data-id="${esc(it.id)}">已读</button>
                      ${it.convId ? `<button class="btn btn-ghost btn-xs jump-conv-btn" data-id="${esc(it.convId)}">跳转</button>` : ''}
                    </div>`
                  : ''
              }
            </div>
          `;
        })
        .join('')
    );
  }
}

export async function spawnHandoverController(ctx, oldCtrlId) {
  const { state, api, showToast, copyText } = ctx;
  const eff = state.snap?.settings?.effective || {};
  const model = eff.l0ControllerModel || 'Gemini 4 Neon (XHigh)';
  const handoverPrompt = buildPrefilledHandoverText(state.snap);
  try {
    const res = await api('/_sidecar/new-conversation', {
      method: 'POST',
      body: {
        workspace: state.workspace,
        handoverForWorkspace: true,
        sourceConversationId: window.sidecar?.conversationId || '',
        model,
        title: 'Control Tower 换届接班总控',
        message: handoverPrompt,
      },
    });
    const cid =
      res.conversationId ||
      res.result?.conversationId ||
      res.result?.conversation_id ||
      res.result?.response?.conversationId ||
      '';
    showToast(cid ? `已拉起接班总控 ${cid.slice(0, 8)}（已预授权写保护放行）` : '已发起换届接班会话');
    if (cid) {
      window.sidecar?.ui?.toggleConversation?.(cid);
    } else if (oldCtrlId) {
      await copyText(handoverPrompt);
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

export function bindOverviewEvents(ctx) {
  const { $, state, api, render, showToast, withBusyButton, copyText, setModelField, getModelField } = ctx;

  $('edit-lease-btn').addEventListener('click', () => {
    const wasHidden = $('lease-form').classList.contains('hidden');
    if (wasHidden && state.snap?.parsed?.lease) {
      const lease = state.snap.parsed.lease;
      $('lf-lockStatus').value = lease.lockStatus || '';
      $('lf-holder').value = lease.holder || '-';
      $('lf-resource').value = lease.resource || '-';
      $('lf-since').value = lease.since || '-';
      $('lf-scope').value = lease.scope || '-';
      $('lf-releaseCriteria').value = lease.releaseCriteria || '-';
    }
    $('lease-form').classList.toggle('hidden');
  });
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

  $('edit-ctrl-btn').addEventListener('click', () => {
    const wasHidden = $('ctrl-form').classList.contains('hidden');
    if (wasHidden && state.snap) {
      const ctrl = state.snap.parsed?.controller || {};
      const eff = state.snap.settings?.effective || {};
      const cleanModel = String(ctrl.defaultModel || eff.l0ControllerModel || 'Gemini 4 Neon (XHigh)')
        .replace(/^`+|`+$/g, '')
        .trim();
      $('cf-controllerId').value = ctrl.currentControllerId || window.sidecar?.conversationId || '';
      $('cf-status').value = ctrl.currentControllerStatus || 'ONLINE';
      setModelField('cf-defaultModel', cleanModel && cleanModel !== '-' ? cleanModel : 'Gemini 4 Neon (XHigh)');
    }
    $('ctrl-form').classList.toggle('hidden');
  });

  $('ctrl-learn-btn')?.addEventListener('click', async () => {
    const btn = $('ctrl-learn-btn');
    const id = state.snap?.parsed?.controller?.currentControllerId;
    if (!id) return showToast('未登记现役总控 ID', true);
    await withBusyButton(btn, async () => {
      try {
        await api('/_sidecar/send-message', {
          method: 'POST',
          body: {
            conversationId: id,
            title: '[CT学习沉淀]',
            message:
              '/learn 请结合本会话近期用户纠偏、排障根因与阶段经验候选，按原生 /learn 规范产出精简 learning_proposal.md 提案供我审批；如无新可复用经验请直接说明无需变更。',
          },
        });
        showToast('已向现役总控发送 /learn 学习指令');
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
  $('cancel-ctrl-btn').addEventListener('click', () => {
    $('cf-appendHistory').checked = false;
    $('cf-summary').value = '';
    $('ctrl-form').classList.add('hidden');
  });

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
          defaultModel: getModelField('cf-defaultModel'),
          appendHistory: $('cf-appendHistory').checked,
          summary: $('cf-summary').value.trim(),
        },
      });
      $('cf-appendHistory').checked = false;
      $('cf-summary').value = '';
      $('ctrl-form').classList.add('hidden');
      render(res.snapshot);
      showToast('已更新现役总控配置');
    } catch (err) {
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
    const ok = await copyText(buildPrefilledHandoverText(state.snap));
    showToast(ok ? '已复制预填换届交接卡' : '复制失败', !ok);
  };
  $('copy-handover-btn').addEventListener('click', handleCopyHandover);
  $('copy-handover-raw-btn').addEventListener('click', handleCopyHandover);

  $('ctrl-handover-spawn-btn').addEventListener('click', () =>
    withBusyButton($('ctrl-handover-spawn-btn'), () =>
      spawnHandoverController(ctx, state.snap?.parsed?.controller?.currentControllerId || '')
    )
  );

  $('ctrl-ignore-handover-btn').addEventListener('click', async () => {
    const ctrlId = state.snap?.parsed?.controller?.currentControllerId || '';
    try {
      const res = await api('/api/attention/dismiss', {
        method: 'POST',
        body: {
          workspace: state.workspace,
          kind: 'handover',
          controllerId: ctrlId,
          ignoreForSession: true,
        },
      });
      render(res.snapshot);
      showToast('已标记当前总控会话忽略换届提醒');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('sentinel-sweep-btn').addEventListener('click', () =>
    withBusyButton($('sentinel-sweep-btn'), async () => {
      if (!state.workspace) return;
      try {
        const res = await api('/api/sentinel/sweep', {
          method: 'POST',
          body: { workspace: state.workspace },
        });
        render(res.snapshot);
        showToast(`哨兵巡检完成，新捕获 ${res.detectedCount || 0} 条事件`);
      } catch (err) {
        showToast(err.message, true);
      }
    })
  );

  $('inbox-deliver-all-btn').addEventListener('click', () =>
    withBusyButton($('inbox-deliver-all-btn'), async () => {
      if (!state.workspace) return;
      try {
        const res = await api('/api/inbox/deliver', {
          method: 'POST',
          body: { workspace: state.workspace },
        });
        render(res.snapshot);
        showToast(
          res.deliveredCount > 0 ? `已向总控投递 ${res.deliveredCount} 条信箱事件` : '暂无未读事件可投递'
        );
      } catch (err) {
        showToast(err.message, true);
      }
    })
  );

  $('inbox-ack-all-btn').addEventListener('click', async () => {
    if (!state.workspace) return;
    try {
      const res = await api('/api/inbox/ack', {
        method: 'POST',
        body: { workspace: state.workspace, ackAll: true },
      });
      render(res.snapshot);
      showToast('已将全部后台信箱事件标为已读');
    } catch (err) {
      showToast(err.message, true);
    }
  });
}
