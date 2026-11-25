import {
  escHtml as esc,
  formatFlightEventRow,
  summarizeDiagnosticsBadge,
} from '../ui-logic.mjs';

function setOvTag($, key, isWsOverride) {
  const el = $(`ov-tag-${key}`);
  if (!el) return;
  el.textContent = isWsOverride ? '工作区覆盖' : '继承全局';
  el.className = `badge ${isWsOverride ? 'badge-warn' : 'badge-muted'}`;
}

export function syncGlobalDocEditor(ctx, snap) {
  const { $, state } = ctx;
  const docName = $('global-doc-select').value;
  const docs = snap.settings?.docs || {};
  const d = docs[docName] || {};
  const hasGlobal = Boolean(d.hasGlobalOverride);
  $('global-doc-badge').textContent = hasGlobal ? '已存在全局覆盖' : '使用内置基准';
  $('global-doc-badge').className = `badge ${hasGlobal ? 'badge-warn' : 'badge-muted'}`;
  if (!state.globalDocDirty && document.activeElement !== $('global-doc-editor')) {
    $('global-doc-editor').value =
      d.source === 'global' ? d.content || '' : d.builtinContent || d.content || '';
  }
}

export function syncWsDocEditor(ctx, snap) {
  const { $, state } = ctx;
  const docName = $('ws-doc-select').value;
  const docs = snap.settings?.docs || {};
  const d = docs[docName] || {};
  const hasWs = Boolean(d.hasWorkspaceOverride);
  $('ws-doc-badge').textContent = hasWs ? '已存在工作区覆盖' : `继承 (${d.source || 'builtin'})`;
  $('ws-doc-badge').className = `badge ${hasWs ? 'badge-warn' : 'badge-muted'}`;
  if (!state.wsDocDirty && document.activeElement !== $('ws-doc-editor')) {
    $('ws-doc-editor').value = d.content || '';
  }
}

export function renderSettings(ctx, snap) {
  const { $, state } = ctx;
  const s = snap.settings || {};
  const p = s.plugin || {};
  const g = s.global || {};
  const w = s.workspace || {};
  const eff = s.effective || {};
  const ov = w.overrides || {};
  const hp = s.hostPermission || {};

  // Layer 1: Plugin
  if (!state.settingsDirty.plugin) {
    $('ps-livePollEnabled').checked = p.livePollEnabled !== false;
    $('ps-livePollIntervalSec').value = String(p.livePollIntervalSec ?? 4);
    $('ps-uiMotion').value = p.uiMotion || 'standard';
    $('ps-attentionBannerEnabled').checked = p.attentionBannerEnabled !== false;
    $('ps-dualRoleHookEnabled').checked = p.dualRoleHookEnabled !== false;
    $('ps-stopHookReportEnabled').checked = p.stopHookReportEnabled !== false;
    $('ps-registryWriteGuard').value = p.registryWriteGuard || 'ask';
    $('ps-maxLookupInputLength').value = String(p.maxLookupInputLength ?? 2000);
    $('ps-maxLookupCandidates').value = String(p.maxLookupCandidates ?? 6);
    $('ps-sentinelEnabled').checked = p.sentinelEnabled !== false;
    $('ps-sentinelIntervalSec').value = String(p.sentinelIntervalSec ?? 15);
    $('ps-focusCooldownSec').value = String(p.focusCooldownSec ?? 180);
    $('ps-stuckThresholdMin').value = String(p.stuckThresholdMin ?? 15);
  }

  // Layer 2: Global
  const hostDesc = hp.available
    ? `宿主权限检测: preset=${hp.permissionPreset || '-'} | exec=${hp.autoExecutionPolicy || '-'} -> 映射档位: ${eff.effectiveAutonomy || 'balanced'}`
    : `未检测到宿主权限文件，跟随模式下默认采用 balanced 均衡档`;
  $('host-perm-summary').textContent = hostDesc;
  if (!state.settingsDirty.global) {
    $('gs-l0ControllerModel').value = g.l0ControllerModel || 'Orchestrator (Neon Extra High)';
    $('gs-l1LightModel').value = g.l1LightModel || 'Gemini 4 Hydrogen (XHigh)';
    $('gs-l2StandardModel').value = g.l2StandardModel || 'Orchestrator (Neon Extra High)';
    $('gs-l3DeepModel').value = g.l3DeepModel || 'Orchestrator (Carbon)';
    $('gs-l4IntegrationModel').value = g.l4IntegrationModel || 'Orchestrator (Neon Extra High)';
    $('gs-modelGuardPolicy').value = g.modelGuardPolicy || 'strict_gemini4';
    $('gs-customAllowedModels').value = Array.isArray(g.customAllowedModels)
      ? g.customAllowedModels.join(', ')
      : '';
    $('gs-decisionAutonomy').value = g.decisionAutonomy || 'inherit';
    $('gs-askBeforeDispatch').checked = g.askBeforeDispatch !== false;
    $('gs-notifyOnSingleTaskDone').checked = Boolean(g.notifyOnSingleTaskDone);
    $('gs-controllerCompactionThreshold').value = String(g.controllerCompactionThreshold ?? 5);
    $('gs-workerCompactionThreshold').value = String(g.workerCompactionThreshold ?? 2);
    $('gs-dispatchSurfacePolicy').value = g.dispatchSurfacePolicy || 'hidden_first';
    $('gs-autoLearnMode').value = g.autoLearnMode || 'smart_proposal';
  }
  syncGlobalDocEditor(ctx, snap);

  // Layer 3: Workspace
  const hasWs = Boolean(snap.workspace);
  $('ws-settings-empty').classList.toggle('hidden', hasWs);
  $('ws-settings-body').classList.toggle('hidden', !hasWs);
  if (hasWs) {
    $('ws-settings-badge').textContent = snap.workspace.split('/').filter(Boolean).pop() || 'workspace';
    if (!state.settingsDirty.workspace) {
      $('ws-exclusiveLeaseEnabled').checked = w.exclusiveLeaseEnabled !== false;
      $('ws-registryMode').value = w.registryMode || 'workspace_auto';
      $('ws-customRegistryRelPath').value = w.customRegistryRelPath || '';
      $('ws-custom-rel-wrap').classList.toggle('hidden', $('ws-registryMode').value !== 'workspace_custom');

      ['l0ControllerModel', 'l2StandardModel', 'l3DeepModel'].forEach((k) => {
        const hasOv = Object.prototype.hasOwnProperty.call(ov, k);
        $(`ws-ov-${k}`).value = hasOv ? ov[k] : '';
        $(`ws-ov-${k}`).placeholder = `继承全局 (${g[k] || '-'})`;
        setOvTag($, k, hasOv);
      });

      const hasAutoOv = Object.prototype.hasOwnProperty.call(ov, 'decisionAutonomy');
      $('ws-ov-decisionAutonomy').value = hasAutoOv ? ov.decisionAutonomy : '';
      setOvTag($, 'decisionAutonomy', hasAutoOv);

      const hasAskOv = Object.prototype.hasOwnProperty.call(ov, 'askBeforeDispatch');
      $('ws-ov-askBeforeDispatch').value = hasAskOv ? String(ov.askBeforeDispatch) : '';
      setOvTag($, 'askBeforeDispatch', hasAskOv);

      const hasNotifyOv = Object.prototype.hasOwnProperty.call(ov, 'notifyOnSingleTaskDone');
      $('ws-ov-notifyOnSingleTaskDone').value = hasNotifyOv ? String(ov.notifyOnSingleTaskDone) : '';
      setOvTag($, 'notifyOnSingleTaskDone', hasNotifyOv);

      const hasThreshOv = Object.prototype.hasOwnProperty.call(ov, 'controllerCompactionThreshold');
      $('ws-ov-controllerCompactionThreshold').value = hasThreshOv
        ? String(ov.controllerCompactionThreshold)
        : '';
      $('ws-ov-controllerCompactionThreshold').placeholder = `继承全局 (${g.controllerCompactionThreshold ?? 5})`;
      setOvTag($, 'controllerCompactionThreshold', hasThreshOv);

      const hasLearnOv = Object.prototype.hasOwnProperty.call(ov, 'autoLearnMode');
      $('ws-ov-autoLearnMode').value = hasLearnOv ? ov.autoLearnMode : '';
      setOvTag($, 'autoLearnMode', hasLearnOv);
    }

    syncWsDocEditor(ctx, snap);
  }
}

export function renderDiagnostics(ctx, payload) {
  const { $ } = ctx;
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

export async function loadDiagnostics(ctx, { silent = false } = {}) {
  const { $, state, api, showToast } = ctx;
  const seq = ++state.diagSeq;
  try {
    const level = $('diag-level-filter')?.value || '';
    const qs = level ? `?limit=60&level=${encodeURIComponent(level)}` : '?limit=60';
    const data = await api(`/api/diagnostics${qs}`);
    if (seq !== state.diagSeq) return;
    state.diagLoaded = true;
    renderDiagnostics(ctx, data);
  } catch (err) {
    if (!silent && seq === state.diagSeq) showToast(err.message, true);
  }
}

export function bindSettingsEvents(ctx) {
  const { $, state, api, render, showToast, confirmInline } = ctx;

  $('plugin-settings-form').addEventListener('input', () => {
    state.settingsDirty.plugin = true;
  });
  $('plugin-settings-form').addEventListener('change', () => {
    state.settingsDirty.plugin = true;
  });
  $('global-settings-form').addEventListener('input', () => {
    state.settingsDirty.global = true;
  });
  $('global-settings-form').addEventListener('change', () => {
    state.settingsDirty.global = true;
  });
  $('ws-settings-form').addEventListener('input', () => {
    state.settingsDirty.workspace = true;
  });
  $('ws-settings-form').addEventListener('change', () => {
    state.settingsDirty.workspace = true;
  });
  $('global-doc-editor').addEventListener('input', () => {
    state.globalDocDirty = true;
  });
  $('ws-doc-editor').addEventListener('input', () => {
    state.wsDocDirty = true;
  });

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
          sentinelEnabled: $('ps-sentinelEnabled').checked,
          sentinelIntervalSec: Number($('ps-sentinelIntervalSec').value),
          focusCooldownSec: Number($('ps-focusCooldownSec').value),
          stuckThresholdMin: Number($('ps-stuckThresholdMin').value),
        },
      });
      state.settingsDirty.plugin = false;
      render(res.snapshot);
      showToast('已保存插件设置');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('ps-reset-btn').addEventListener('click', () => {
    confirmInline($('ps-reset-btn'), '确认重置?', async () => {
      try {
        const res = await api('/api/settings/plugin', {
          method: 'POST',
          body: { workspace: state.workspace, action: 'reset' },
        });
        state.settingsDirty.plugin = false;
        render(res.snapshot);
        showToast('已恢复插件默认设置');
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  $('clear-cache-btn').addEventListener('click', async () => {
    try {
      const res = await api('/api/cache/clear', {
        method: 'POST',
        body: { workspace: state.workspace },
      });
      render(res.snapshot);
      showToast('已清理遥测与元数据缓存');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('diag-level-filter').addEventListener('change', () => loadDiagnostics(ctx));
  $('diag-refresh-btn').addEventListener('click', () => loadDiagnostics(ctx));
  $('diag-clear-btn').addEventListener('click', () => {
    confirmInline($('diag-clear-btn'), '确认清空?', async () => {
      try {
        const data = await api('/api/diagnostics/clear', { method: 'POST', body: {} });
        renderDiagnostics(ctx, data);
        showToast('已清空黑匣子诊断日志');
      } catch (err) {
        showToast(err.message, true);
      }
    });
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
          dispatchSurfacePolicy: $('gs-dispatchSurfacePolicy').value,
          autoLearnMode: $('gs-autoLearnMode').value,
        },
      });
      state.settingsDirty.global = false;
      render(res.snapshot);
      showToast('已保存全局设置');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('gs-reset-btn').addEventListener('click', () => {
    confirmInline($('gs-reset-btn'), '确认重置?', async () => {
      try {
        const res = await api('/api/settings/global', {
          method: 'POST',
          body: { workspace: state.workspace, action: 'reset' },
        });
        state.settingsDirty.global = false;
        render(res.snapshot);
        showToast('已重置全局设置为内置默认');
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  $('global-doc-select').addEventListener('change', () => {
    state.globalDocDirty = false;
    if (state.snap) {
      $('global-doc-editor').blur();
      syncGlobalDocEditor(ctx, state.snap);
    }
  });

  $('global-doc-load-builtin-btn').addEventListener('click', () => {
    const docName = $('global-doc-select').value;
    const d = state.snap?.settings?.docs?.[docName];
    if (d) {
      $('global-doc-editor').value = d.builtinContent || d.content || '';
      state.globalDocDirty = true;
    }
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
      state.globalDocDirty = false;
      render(res.snapshot);
      showToast('已保存全局文档覆盖');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('global-doc-reset-btn').addEventListener('click', () => {
    confirmInline($('global-doc-reset-btn'), '确认清除?', async () => {
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
        state.globalDocDirty = false;
        render(res.snapshot);
        showToast('已清除全局文档覆盖');
      } catch (err) {
        showToast(err.message, true);
      }
    });
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
    overrides.autoLearnMode = $('ws-ov-autoLearnMode').value || null;

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
      state.settingsDirty.workspace = false;
      render(res.snapshot);
      showToast('已保存当前工作区设置');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('ws-reset-btn').addEventListener('click', () => {
    if (!state.workspace) return;
    confirmInline($('ws-reset-btn'), '确认重置?', async () => {
      try {
        const res = await api('/api/settings/workspace', {
          method: 'POST',
          body: { workspace: state.workspace, action: 'reset' },
        });
        state.settingsDirty.workspace = false;
        render(res.snapshot);
        showToast('已重置当前工作区全部设置');
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  $('ws-doc-select').addEventListener('change', () => {
    state.wsDocDirty = false;
    if (state.snap) {
      $('ws-doc-editor').blur();
      syncWsDocEditor(ctx, state.snap);
    }
  });

  $('ws-doc-load-effective-btn').addEventListener('click', () => {
    const docName = $('ws-doc-select').value;
    const d = state.snap?.settings?.docs?.[docName];
    if (d) {
      $('ws-doc-editor').value = d.content || '';
      state.wsDocDirty = true;
    }
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
      state.wsDocDirty = false;
      render(res.snapshot);
      showToast('已保存工作区文档覆盖');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('ws-doc-reset-btn').addEventListener('click', () => {
    if (!state.workspace) return;
    confirmInline($('ws-doc-reset-btn'), '确认清除?', async () => {
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
        state.wsDocDirty = false;
        render(res.snapshot);
        showToast('已清除工作区文档覆盖');
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}
