import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ackInboxItems,
  buildUnifiedAttentionBanner,
  cleanupWorkspaceInbox,
  clearDeferredReceipt,
  evaluateFocusGate,
  evaluateSentinelSweep,
  loadWorkspaceInbox,
  summarizeInbox,
} from '../../lib/inbox.mjs';
import {
  appendFlightEvent,
  clearFlightLogs,
  readFlightEvents,
  SLOW_OP_THRESHOLD_MS,
  SLOW_RPC_THRESHOLD_MS,
  summarizeFlightEvents,
} from '../../lib/logger.mjs';
import {
  atomicWriteText,
  findExistingRegistry,
  loadKnownWorkspaces,
  MANAGED_REGISTRY_VIRTUAL_REL,
  normalizeWorkspaceInput,
  PathError,
  readJsonSafe,
  recordKnownWorkspace,
  resolveAppDataDirs,
  resolvePluginDataDir,
  resolveRegistryTarget,
  sha256,
} from '../../lib/paths.mjs';
import {
  archiveActiveSession,
  deleteQueueRow,
  extractTemplatesFromMarkdown,
  parseRegistry,
  updateControllerSection,
  updateLeaseSection,
  upsertActiveSessionRow,
  upsertQueueRow,
} from '../../lib/registry.mjs';
import {
  loadWorkspaceRoadmap,
  updateRoadmapNodeStatus,
} from '../../lib/roadmap.mjs';
import {
  MODEL_PRESETS,
  normalizeModelForAgentApi,
  resetDocOverride,
  resetGlobalSettings,
  resetPluginSettings,
  resetWorkspaceSettings,
  resolveEffectiveSettings,
  saveDocOverride,
  saveGlobalSettings,
  savePluginSettings,
  saveWorkspaceSettings,
  validateDispatchModel,
} from '../../lib/settings.mjs';
import {
  inspectById,
  inspectHiddenSurfaces,
  inspectNativeSwarm,
  inspectTranscript,
  isValidConvIdOrPrefix,
  loadPluginState,
  resolveBrainTranscript,
  updatePluginState,
} from '../../lib/transcript.mjs';
import {
  ALLOWED_SLASH_PREFIXES,
  buildDispatchPayload,
  clearMetadataCache,
  execAgentApiAsync,
  extractConversationIdFromResult,
  getConversationMetadataCached,
  invalidateMetadataCache,
  safePositionalMessage,
} from './lib/agentapi.mjs';
import { handleInboxAndSwarmRoute } from './routes/inbox.mjs';
import { handleRoadmapRoute } from './routes/roadmap.mjs';
import { buildMultiWorkspaceOverview, handleWorkspacesRoute } from './routes/workspaces.mjs';
import { buildClassicAppBundle, computeAssetStamp, computeBundleSignature } from './lib/bundle.mjs';
import { SseHub } from './lib/sse-hub.mjs';
import { isLeaseIdle } from './ui-logic.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..', '..');

const MAX_FILE_BYTES = 512 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CACHE_ENTRIES = 200;
const MULTI_WS_CACHE_TTL_MS = 5000;
const NO_STORE_HEADERS = Object.freeze({ 'Cache-Control': 'no-store, no-cache, must-revalidate' });

const RPC_API_ROUTES = new Set([
  '/api/dispatch/create',
  '/api/inbox/deliver',
  '/api/roadmap/node/dispatch-hidden',
  '/api/swarm/cleanup-request',
]);

class HttpError extends Error {
  constructor(status, message, extra = null) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function getDataDir() {
  return resolvePluginDataDir({ env: process.env });
}

function getRecentPath() {
  return join(getDataDir(), 'recent-workspaces.json');
}

function findPreloadJs() {
  const require = createRequire(import.meta.url);
  try {
    const preloadPath = require.resolve('sidecar_sdk/preload.js');
    if (existsSync(preloadPath)) return readFileSync(preloadPath, 'utf8');
  } catch {
    // not loaded via sidecar_sdk register_loader
  }
  try {
    const sdkEntry = require.resolve('sidecar_sdk');
    const candidate = join(dirname(sdkEntry), 'preload.js');
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  } catch {
    // fallback below
  }
  for (const appDir of resolveAppDataDirs({ env: process.env })) {
    const cand = join(appDir, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js');
    if (existsSync(cand)) {
      try {
        return readFileSync(cand, 'utf8');
      } catch {
        // ignore
      }
    }
  }
  return 'window.sidecar = window.sidecar || { getWorkspaceUris: async () => [], onWorkspaceChange: () => () => {} };\n';
}

function readPluginMeta() {
  const raw = readJsonSafe(join(PLUGIN_ROOT, 'plugin.json'), {});
  return {
    name: raw?.name || 'control-tower',
    displayName: raw?.displayName || 'Control Tower',
    version: raw?.version || '1.9.1',
  };
}

function loadRecentWorkspaces(seedWs = '') {
  return loadKnownWorkspaces(getDataDir(), {
    seedWorkspaces: seedWs ? [seedWs] : [],
    maxEntries: 24,
  });
}

function recordRecentWorkspace(wsReal) {
  try {
    return recordKnownWorkspace(getDataDir(), wsReal, { maxEntries: 24 });
  } catch {
    return wsReal ? [wsReal] : [];
  }
}

class ControlTowerServer {
  #port;
  #token;
  #staticAssets;
  #transcriptCache;
  #server;
  #activeWorkspace;
  #sentinelTimer;
  #sentinelRunning;
  #workspaceMutexes;
  #lastAuthRejectLogAt;
  #sseHub;
  #bundleCache;
  #multiWsCache;

  constructor({
    port = Number.parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '0', 10),
    token = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '',
  } = {}) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error('Invalid ANTIGRAVITY_SIDECAR_WEB_PORT');
    }
    this.#port = port;
    this.#token = token;
    this.#transcriptCache = {};
    this.#activeWorkspace = '';
    this.#sentinelTimer = null;
    this.#sentinelRunning = false;
    this.#workspaceMutexes = new Map();
    this.#lastAuthRejectLogAt = 0;
    this.#bundleCache = null;
    this.#multiWsCache = null;
    this.#sseHub = new SseHub({
      onFsEvent: ({ workspace }) => {
        this.#invalidateMultiWsCache();
        const targetWs = workspace || this.#activeWorkspace;
        if (targetWs) {
          void this.#flushDeferredReceiptForWorkspace(targetWs);
        }
      },
    });
    this.#staticAssets = new Map([
      ['/', { file: join(__dirname, 'index.html'), type: 'text/html; charset=utf-8' }],
      ['/index.html', { file: join(__dirname, 'index.html'), type: 'text/html; charset=utf-8' }],
      ['/styles.css', { file: join(__dirname, 'styles.css'), type: 'text/css; charset=utf-8' }],
      ['/boot-guard.js', { file: join(__dirname, 'boot-guard.js'), type: 'application/javascript; charset=utf-8' }],
      ['/app.js', { file: join(__dirname, 'app.js'), type: 'application/javascript; charset=utf-8' }],
      ['/ui-logic.mjs', { file: join(__dirname, 'ui-logic.mjs'), type: 'application/javascript; charset=utf-8' }],
      ['/views/overview.mjs', { file: join(__dirname, 'views', 'overview.mjs'), type: 'application/javascript; charset=utf-8' }],
      ['/views/sessions.mjs', { file: join(__dirname, 'views', 'sessions.mjs'), type: 'application/javascript; charset=utf-8' }],
      ['/views/roadmap.mjs', { file: join(__dirname, 'views', 'roadmap.mjs'), type: 'application/javascript; charset=utf-8' }],
      ['/views/settings.mjs', { file: join(__dirname, 'views', 'settings.mjs'), type: 'application/javascript; charset=utf-8' }],
    ]);
  }

  #pruneCache() {
    const keys = Object.keys(this.#transcriptCache);
    if (keys.length <= MAX_CACHE_ENTRIES) return;
    keys.sort(
      (a, b) =>
        (this.#transcriptCache[b]?.updatedAt || 0) -
        (this.#transcriptCache[a]?.updatedAt || 0)
    );
    const next = {};
    for (const k of keys.slice(0, MAX_CACHE_ENTRIES)) {
      next[k] = this.#transcriptCache[k];
    }
    this.#transcriptCache = next;
  }

  #validToken(req, url) {
    if (!this.#token) return true;
    const raw = req.headers['x-sidecar-token'] ?? url.searchParams.get('token');
    if (typeof raw !== 'string' || !raw) return false;
    const a = createHash('sha256').update(raw, 'utf8').digest();
    const b = createHash('sha256').update(this.#token, 'utf8').digest();
    return timingSafeEqual(a, b);
  }

  #invalidateMultiWsCache() {
    this.#multiWsCache = null;
  }

  #getMultiWorkspaceOverview({ currentWorkspace = '', recentWorkspaces = [], dataDir = '' } = {}) {
    const recentList = Array.isArray(recentWorkspaces) ? recentWorkspaces : [];
    const key = `${currentWorkspace}::${recentList.join('|')}::${dataDir}`;
    const now = Date.now();
    if (
      this.#multiWsCache &&
      this.#multiWsCache.key === key &&
      now - this.#multiWsCache.ts < MULTI_WS_CACHE_TTL_MS
    ) {
      return this.#multiWsCache.data;
    }
    const data = buildMultiWorkspaceOverview({
      currentWorkspace,
      recentWorkspaces: recentList,
      dataDir,
      pluginRoot: PLUGIN_ROOT,
    });
    this.#multiWsCache = { key, ts: now, data };
    return data;
  }

  #getClassicBundle() {
    const sig = computeBundleSignature(__dirname);
    if (this.#bundleCache && this.#bundleCache.sig === sig) {
      return this.#bundleCache;
    }
    this.#bundleCache = buildClassicAppBundle(__dirname);
    return this.#bundleCache;
  }

  #validOrigin(req) {
    const origin = req.headers.origin;
    if (!origin || typeof origin !== 'string') return true;
    return (
      origin.startsWith('http://127.0.0.1') ||
      origin.startsWith('https://127.0.0.1') ||
      origin.startsWith('http://localhost') ||
      origin.startsWith('https://localhost') ||
      origin.startsWith('http://[::1]') ||
      origin.startsWith('https://[::1]') ||
      origin.startsWith('vscode-webview://') ||
      origin === 'null' ||
      origin.startsWith('file://')
    );
  }

  #logFlightSafe(entry, { allowCreate = true } = {}) {
    const d = getDataDir();
    if (!allowCreate && !existsSync(d)) return;
    appendFlightEvent(d, entry);
  }

  async #withWorkspaceMutex(wsReal, fn) {
    if (!wsReal) return fn();
    const prev = this.#workspaceMutexes.get(wsReal) || Promise.resolve();
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const chain = prev.then(() => gate);
    this.#workspaceMutexes.set(wsReal, chain);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.#workspaceMutexes.get(wsReal) === chain) {
        this.#workspaceMutexes.delete(wsReal);
      }
    }
  }

  #sendJson(res, status, obj, extraHeaders = {}) {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
    res.end(JSON.stringify(obj));
  }

  async #readBody(req) {
    return await new Promise((resolveBody, rejectBody) => {
      const chunks = [];
      let total = 0;
      let settled = false;

      const timer = setTimeout(() => {
        done(new HttpError(408, 'Request body read timeout'));
      }, 15000);
      if (typeof timer.unref === 'function') timer.unref();

      const done = (err, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) rejectBody(err);
        else resolveBody(val);
      };

      req.on('data', (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          chunks.length = 0;
          req.pause();
          done(new HttpError(413, 'Request body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (settled) return;
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) return done(null, {});
        try {
          const parsed = JSON.parse(raw);
          done(null, parsed && typeof parsed === 'object' ? parsed : {});
        } catch {
          done(new HttpError(400, 'Invalid JSON body'));
        }
      });
      req.on('aborted', () => done(new HttpError(400, 'Request aborted')));
      req.on('close', () => {
        if (!settled) done(new HttpError(400, 'Request stream closed early'));
      });
      req.on('error', (err) => done(err));
    });
  }

  #buildSnapshot(wsRaw, { recentOverride = null } = {}) {
    const dataDir = getDataDir();
    const plugin = readPluginMeta();
    const recent = recentOverride || loadRecentWorkspaces();
    const wsReal = wsRaw
      ? normalizeWorkspaceInput(wsRaw, { throwOnInvalid: true })
      : recent[0] || null;

    const resolved = resolveEffectiveSettings({
      dataDir,
      wsReal: wsReal || '',
      pluginRoot: PLUGIN_ROOT,
      env: process.env,
    });
    const templates = extractTemplatesFromMarkdown(resolved.docs['templates.md']?.content || '');
    const settingsPayload = { ...resolved, modelPresets: MODEL_PRESETS };
    const emptySwarm = { active: false, title: '', members: [], recentPosts: [] };
    const emptySurfaces = { swarm: emptySwarm, subagents: [], workflows: [], topLevel: [] };
    const emptyInbox = summarizeInbox(null, { focusCooldownSec: resolved.plugin.focusCooldownSec });
    const emptyRoadmap = {
      exists: false,
      isManaged: false,
      l1Rel: '',
      l2Rel: '',
      l1Path: '',
      l2Path: '',
      l1Content: '',
      northStarBrief: '',
      data: null,
      graph: null,
    };

    if (!wsReal) {
      const multiWorkspace = this.#getMultiWorkspaceOverview({
        currentWorkspace: '',
        recentWorkspaces: recent,
        dataDir,
      });
      return {
        plugin,
        workspace: '',
        recentWorkspaces: recent,
        multiWorkspace,
        registryExists: false,
        registryIsManaged: false,
        registryRelPath: '',
        registryPath: '',
        hash: '',
        content: '',
        parsed: parseRegistry(''),
        templates,
        settings: settingsPayload,
        nativeSwarm: emptySwarm,
        executionSurfaces: emptySurfaces,
        inbox: emptyInbox,
        roadmap: emptyRoadmap,
        attention: { items: [], handoverIgnored: false },
      };
    }

    const found = findExistingRegistry(wsReal, {
      dataDir,
      workspaceSettings: resolved.workspace,
    });
    const wsRoadmap = loadWorkspaceRoadmap(wsReal, {
      dataDir,
      workspaceSettings: resolved.workspace,
    });
    const multiWorkspace = this.#getMultiWorkspaceOverview({
      currentWorkspace: wsReal,
      recentWorkspaces: recent,
      dataDir,
    });

    if (!found) {
      const wsInboxSummary = summarizeInbox(loadWorkspaceInbox(dataDir, wsReal), {
        focusCooldownSec: resolved.plugin.focusCooldownSec,
      });
      return {
        plugin,
        workspace: wsReal,
        recentWorkspaces: recent,
        multiWorkspace,
        registryExists: false,
        registryIsManaged: false,
        registryRelPath: '',
        registryPath: '',
        hash: '',
        content: '',
        parsed: parseRegistry(''),
        templates,
        settings: settingsPayload,
        nativeSwarm: emptySwarm,
        executionSurfaces: emptySurfaces,
        inbox: wsInboxSummary,
        roadmap: wsRoadmap,
        attention: { items: [], handoverIgnored: false },
      };
    }

    const content = readFileSync(found.absPath, 'utf8');
    const parsed = parseRegistry(content);
    const ctrlId = String(parsed.controller.currentControllerId || '').trim();
    if (ctrlId) {
      parsed.controller.telemetry = inspectById(ctrlId, {
        env: process.env,
        cacheMap: this.#transcriptCache,
      });
    }
    parsed.activeSessions = parsed.activeSessions.map((s) => ({
      ...s,
      telemetry: s.conversationId
        ? inspectById(s.conversationId, {
            env: process.env,
            cacheMap: this.#transcriptCache,
          })
        : null,
    }));

    const nativeSwarm = ctrlId
      ? inspectNativeSwarm(ctrlId, { env: process.env, cacheMap: this.#transcriptCache })
      : emptySwarm;
    const hidden = ctrlId
      ? inspectHiddenSurfaces(ctrlId, { env: process.env, cacheMap: this.#transcriptCache })
      : { subagents: [], workflows: [] };
    this.#pruneCache();

    const pluginState = loadPluginState(dataDir);
    const handoverIgnored = Boolean(ctrlId && pluginState.controllers?.[ctrlId]?.handoverIgnored);
    const wsInboxSummary = summarizeInbox(loadWorkspaceInbox(dataDir, wsReal), {
      focusCooldownSec: resolved.plugin.focusCooldownSec,
      activeControllerId: ctrlId,
      handoverIgnored,
    });
    const attention = buildUnifiedAttentionBanner(wsInboxSummary, {
      activeControllerId: ctrlId,
      controllerCompactions: Number(parsed.controller?.telemetry?.compactions || 0),
      compactionThreshold: resolved.effective.controllerCompactionThreshold || 5,
      handoverIgnored,
    });

    const executionSurfaces = {
      swarm: nativeSwarm,
      subagents: hidden.subagents,
      workflows: hidden.workflows,
      topLevel: parsed.activeSessions,
    };

    return {
      plugin,
      workspace: wsReal,
      recentWorkspaces: recent,
      multiWorkspace,
      registryExists: true,
      registryIsManaged: Boolean(found.isManaged),
      registryRelPath: found.relPath,
      registryPath: found.absPath,
      hash: sha256(content),
      content,
      parsed,
      templates,
      settings: settingsPayload,
      nativeSwarm,
      executionSurfaces,
      inbox: wsInboxSummary,
      roadmap: wsRoadmap,
      attention,
    };
  }

  async #flushDeferredReceiptForWorkspace(wsReal) {
    if (!wsReal) return false;
    const dataDir = getDataDir();
    if (!existsSync(dataDir)) return false;
    try {
      const rawInbox = loadWorkspaceInbox(dataDir, wsReal);
      if (!rawInbox.deferredReceipt) return false;
      const resolved = resolveEffectiveSettings({
        dataDir,
        wsReal,
        pluginRoot: PLUGIN_ROOT,
        env: process.env,
      });
      const gate = evaluateFocusGate(rawInbox.focus, {
        focusCooldownSec: resolved.plugin?.focusCooldownSec || 180,
      });
      if (gate.isForegroundBusy) return false;
      const found = findExistingRegistry(wsReal, {
        dataDir,
        workspaceSettings: resolved.workspace,
      });
      if (!found || !existsSync(found.absPath)) return false;
      const parsed = parseRegistry(readFileSync(found.absPath, 'utf8'));
      const ctrlId = String(parsed.controller?.currentControllerId || '').trim();
      if (!ctrlId || !isValidConvIdOrPrefix(ctrlId)) return false;

      await execAgentApiAsync([
        'send-message',
        '--title',
        '[CT延迟阶段回执]',
        ctrlId,
        safePositionalMessage(rawInbox.deferredReceipt.message),
      ]);
      clearDeferredReceipt(dataDir, wsReal);
      updatePluginState(dataDir, (st) => {
        for (const k of rawInbox.deferredReceipt.completedIds || []) {
          if (st.workers[k]) st.workers[k].pendingSilentDone = false;
        }
      });
      this.#logFlightSafe({
        level: 'info',
        source: 'sidecar',
        event: 'deferred_receipt_relayed',
        conv: ctrlId,
        message: 'Sidecar relayed queued Stop receipt to idle controller',
      });
      return true;
    } catch {
      return false;
    }
  }

  async #runSentinelSweepForWorkspace(wsReal) {
    if (!wsReal) return { detectedCount: 0, detected: [] };
    const dataDir = getDataDir();
    const snap = this.#buildSnapshot(wsReal);
    if (!snap.registryExists) return { detectedCount: 0, detected: [] };
    const sweep = evaluateSentinelSweep({
      dataDir,
      wsReal,
      activeControllerId: String(snap.parsed?.controller?.currentControllerId || '').trim(),
      activeSessions: snap.parsed?.activeSessions || [],
      nativeSwarm: snap.nativeSwarm,
      subagents: snap.executionSurfaces?.subagents || [],
      workerCompactionThreshold: snap.settings?.effective?.workerCompactionThreshold || 2,
      stuckThresholdMin: snap.settings?.plugin?.stuckThresholdMin || 15,
    });

    await this.#flushDeferredReceiptForWorkspace(wsReal);

    if (sweep.detectedCount > 0) {
      this.#invalidateMultiWsCache();
      this.#sseHub.notify({ workspace: wsReal, reason: 'sentinel_sweep' });
    }
    return sweep;
  }

  #ensureSentinelTimer() {
    if (this.#sentinelTimer) {
      clearInterval(this.#sentinelTimer);
      this.#sentinelTimer = null;
    }
    const dataDir = getDataDir();
    if (!this.#activeWorkspace || !existsSync(dataDir)) return;
    const resolved = resolveEffectiveSettings({
      dataDir,
      wsReal: this.#activeWorkspace,
      pluginRoot: PLUGIN_ROOT,
      env: process.env,
    });
    if (resolved.plugin.sentinelEnabled === false) return;
    const sec = Math.max(5, Number(resolved.plugin.sentinelIntervalSec || 15));
    this.#sentinelTimer = setInterval(async () => {
      if (this.#sentinelRunning) return;
      this.#sentinelRunning = true;
      try {
        if (!this.#activeWorkspace || !existsSync(getDataDir())) return;
        await this.#runSentinelSweepForWorkspace(this.#activeWorkspace);
      } catch (err) {
        this.#logFlightSafe({
          level: 'warn',
          source: 'sidecar',
          event: 'sentinel_sweep_error',
          ok: false,
          message: err?.message || 'Sentinel sweep failed',
        });
      } finally {
        this.#sentinelRunning = false;
      }
    }, sec * 1000);
    if (typeof this.#sentinelTimer.unref === 'function') {
      this.#sentinelTimer.unref();
    }
  }

  #loadRegistryForMutation(body) {
    const dataDir = getDataDir();
    const wsReal = normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true });
    if (!wsReal) throw new HttpError(400, 'workspace is required');
    const resolved = resolveEffectiveSettings({
      dataDir,
      wsReal,
      pluginRoot: PLUGIN_ROOT,
      env: process.env,
    });

    let target = null;
    if (body.relPath) {
      const allowCustomRel =
        resolved.workspace.registryMode === 'workspace_custom' &&
        body.relPath === resolved.workspace.customRegistryRelPath;
      target = {
        relPath: body.relPath,
        absPath: resolveRegistryTarget(wsReal, body.relPath, {
          allowMissing: false,
          dataDir,
          allowCustomRel,
        }),
      };
    } else {
      target = findExistingRegistry(wsReal, {
        dataDir,
        workspaceSettings: resolved.workspace,
      });
    }
    if (!target) throw new HttpError(404, 'SESSION-REGISTRY.md not found in workspace');
    const content = readFileSync(target.absPath, 'utf8');
    const currentHash = sha256(content);
    if (body.expectedHash && body.expectedHash !== currentHash) {
      throw new HttpError(409, '台账已被外部会话修改，请重载最新内容后再保存。', {
        currentHash,
        content,
      });
    }
    return { dataDir, wsReal, target, content, currentHash, resolved };
  }

  async #handleSidecarBridge(req, res, url) {
    if (req.method !== 'POST') {
      return this.#sendJson(res, 405, { error: 'Method Not Allowed' });
    }
    const body = await this.#readBody(req);
    if (url.pathname === '/_sidecar/new-conversation') {
      const dataDir = getDataDir();
      const wsReal = body.workspace
        ? normalizeWorkspaceInput(body.workspace, { throwOnInvalid: false })
        : '';
      const resolved = resolveEffectiveSettings({
        dataDir,
        wsReal: wsReal || '',
        pluginRoot: PLUGIN_ROOT,
        env: process.env,
      });
      const check = validateDispatchModel(body.model, resolved.effective);
      if (!check.ok) {
        throw new HttpError(403, check.reason);
      }
      const message = String(body.message || '').trim();
      if (!message) {
        throw new HttpError(400, 'message is required');
      }
      const cliModel = normalizeModelForAgentApi(check.model);
      const args = ['new-conversation', '--model', cliModel];
      if (body.title) args.push('--title', String(body.title).trim());
      args.push(safePositionalMessage(message));
      const result = await execAgentApiAsync(args, { projectId: body.projectId });
      const newConvId = extractConversationIdFromResult(result);

      // Pre-register legitimate handover successor so PreToolUse allows first registry takeover cleanly
      if (body.handoverForWorkspace && wsReal && newConvId) {
        try {
          const wsHash = sha256(wsReal).slice(0, 16);
          updatePluginState(dataDir, (st) => {
            st.pendingSuccessors[wsHash] = { convId: newConvId, createdAt: Date.now() };
          });
        } catch {
          // ignore
        }
      }
      return this.#sendJson(res, 200, { ok: true, cliModel, conversationId: newConvId, result });
    }
    if (url.pathname === '/_sidecar/get-conversation-metadata') {
      const convId = String(body.conversationId || '').trim();
      if (!convId || !isValidConvIdOrPrefix(convId)) {
        throw new HttpError(400, 'Valid conversationId is required');
      }
      const result = await getConversationMetadataCached(convId, { projectId: body.projectId });
      return this.#sendJson(res, 200, result);
    }
    if (url.pathname === '/_sidecar/send-message') {
      const convId = String(body.conversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || '').trim();
      const message = String(body.message || '').trim();
      if (!convId || !isValidConvIdOrPrefix(convId) || !message) {
        throw new HttpError(400, 'Valid conversationId and message are required');
      }
      const args = ['send-message'];
      if (body.title) args.push('--title', String(body.title));
      args.push(convId, safePositionalMessage(message));
      const result = await execAgentApiAsync(args, { projectId: body.projectId });
      invalidateMetadataCache(convId);
      return this.#sendJson(res, 200, result);
    }
    return this.#sendJson(res, 404, { error: 'Not Found' });
  }

  async #handleApi(req, res, url) {
    const dataDir = getDataDir();

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const wsRaw = url.searchParams.get('workspace') || '';
      const wsReal = wsRaw ? normalizeWorkspaceInput(wsRaw, { throwOnInvalid: false }) || '' : '';
      this.#sseHub.subscribe(req, res, { workspace: wsReal, dataDir });
      return;
    }

    if (
      handleWorkspacesRoute({
        req,
        res,
        url,
        dataDir,
        pluginRoot: PLUGIN_ROOT,
        loadRecentWorkspaces,
        sendJson: (r, s, o) => this.#sendJson(r, s, o),
      })
    ) {
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/snapshot') {
      const snap = this.#buildSnapshot(url.searchParams.get('workspace') || '');
      return this.#sendJson(res, 200, snap);
    }

    if (req.method === 'GET' && url.pathname === '/api/settings') {
      const wsRaw = url.searchParams.get('workspace') || '';
      const wsReal = wsRaw ? normalizeWorkspaceInput(wsRaw, { throwOnInvalid: true }) : '';
      const resolved = resolveEffectiveSettings({
        dataDir,
        wsReal: wsReal || '',
        pluginRoot: PLUGIN_ROOT,
        env: process.env,
      });
      return this.#sendJson(res, 200, { ...resolved, modelPresets: MODEL_PRESETS });
    }

    if (req.method === 'GET' && url.pathname === '/api/diagnostics') {
      const limit = Math.max(1, Math.min(200, Number.parseInt(url.searchParams.get('limit') || '60', 10) || 60));
      const level = (url.searchParams.get('level') || '').trim();
      const source = (url.searchParams.get('source') || '').trim();
      const summary = summarizeFlightEvents(dataDir);
      const events = readFlightEvents(dataDir, { limit, level, source });
      return this.#sendJson(res, 200, { ok: true, summary, events });
    }

    if (req.method === 'GET' && url.pathname === '/api/session/inspect') {
      const q = (url.searchParams.get('id') || '').trim();
      const resInspect = resolveBrainTranscript(q, { env: process.env });
      if (resInspect.status !== 'ok') {
        return this.#sendJson(res, 200, {
          status: resInspect.status,
          conversationId: resInspect.conversationId,
          matches: resInspect.matches,
          info: null,
        });
      }
      const prevCache = this.#transcriptCache[resInspect.path] || null;
      const { info, nextCacheEntry } = inspectTranscript(resInspect.path, { cacheEntry: prevCache });
      if (nextCacheEntry) {
        this.#transcriptCache[resInspect.path] = nextCacheEntry;
        this.#pruneCache();
      }
      return this.#sendJson(res, 200, {
        status: 'ok',
        conversationId: resInspect.conversationId,
        matches: resInspect.matches,
        info,
      });
    }

    const body = req.method === 'POST' ? await this.#readBody(req) : {};

    const routeCtx = {
      req,
      res,
      url,
      body,
      dataDir,
      pluginRoot: PLUGIN_ROOT,
      buildSnapshot: (ws) => this.#buildSnapshot(ws),
      runSentinelSweep: (ws) => this.#runSentinelSweepForWorkspace(ws),
      sendJson: (r, s, o) => this.#sendJson(r, s, o),
      HttpError,
    };

    if (await handleRoadmapRoute(routeCtx)) return;
    if (await handleInboxAndSwarmRoute(routeCtx)) return;

    if (req.method !== 'POST') {
      return this.#sendJson(res, 405, { error: 'Method Not Allowed' });
    }

    if (url.pathname === '/api/workspace/select') {
      const wsReal = normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true });
      if (!wsReal) throw new HttpError(400, 'workspace is required');
      this.#activeWorkspace = wsReal;
      const nextRecent = recordRecentWorkspace(wsReal);
      this.#sseHub.trackWorkspace(wsReal, dataDir);
      this.#ensureSentinelTimer();
      const snap = this.#buildSnapshot(wsReal, { recentOverride: nextRecent });
      return this.#sendJson(res, 200, { ok: true, snapshot: snap });
    }

    if (url.pathname === '/api/settings/plugin') {
      const next =
        body.action === 'reset' ? resetPluginSettings(dataDir) : savePluginSettings(dataDir, body);
      this.#ensureSentinelTimer();
      const wsReal = body.workspace
        ? normalizeWorkspaceInput(body.workspace, { throwOnInvalid: false })
        : '';
      return this.#sendJson(res, 200, {
        ok: true,
        plugin: next,
        snapshot: this.#buildSnapshot(wsReal || ''),
      });
    }

    if (url.pathname === '/api/settings/global') {
      const next =
        body.action === 'reset' ? resetGlobalSettings(dataDir) : saveGlobalSettings(dataDir, body);
      const wsReal = body.workspace
        ? normalizeWorkspaceInput(body.workspace, { throwOnInvalid: false })
        : '';
      return this.#sendJson(res, 200, {
        ok: true,
        global: next,
        snapshot: this.#buildSnapshot(wsReal || ''),
      });
    }

    if (url.pathname === '/api/settings/workspace') {
      const wsReal = normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true });
      if (!wsReal) throw new HttpError(400, 'workspace is required');
      const next =
        body.action === 'reset'
          ? resetWorkspaceSettings(dataDir, wsReal)
          : saveWorkspaceSettings(dataDir, wsReal, body);
      return this.#sendJson(res, 200, {
        ok: true,
        workspaceSettings: next,
        snapshot: this.#buildSnapshot(wsReal),
      });
    }

    if (url.pathname === '/api/settings/override') {
      const scope = body.scope;
      const docName = body.docName;
      const wsReal =
        scope === 'workspace'
          ? normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true })
          : body.workspace
            ? normalizeWorkspaceInput(body.workspace, { throwOnInvalid: false })
            : '';
      if (scope === 'workspace' && !wsReal) {
        throw new HttpError(400, 'workspace is required');
      }
      if (body.action === 'reset') {
        resetDocOverride(dataDir, scope, docName, wsReal || '');
      } else {
        saveDocOverride(dataDir, scope, docName, body.content, wsReal || '');
      }
      return this.#sendJson(res, 200, {
        ok: true,
        snapshot: this.#buildSnapshot(wsReal || ''),
      });
    }

    if (url.pathname === '/api/attention/dismiss') {
      const wsReal = body.workspace
        ? normalizeWorkspaceInput(body.workspace, { throwOnInvalid: false })
        : '';
      let ctrlId = String(body.controllerId || '').trim();
      if (body.kind === 'handover' && !ctrlId && wsReal) {
        const found = findExistingRegistry(wsReal, { dataDir });
        if (found) {
          const parsed = parseRegistry(readFileSync(found.absPath, 'utf8'));
          ctrlId = parsed?.controller?.currentControllerId || '';
        }
      }
      updatePluginState(dataDir, (state) => {
        if (body.kind === 'handover') {
          if (ctrlId) {
            state.controllers[ctrlId] = {
              ...(state.controllers[ctrlId] || {}),
              handoverIgnored: body.ignoreForSession !== false,
              updatedAt: Date.now(),
            };
            state.pendingAttention = (state.pendingAttention || []).filter(
              (x) => !(x.kind === 'handover' && (!x.controllerId || x.controllerId === ctrlId))
            );
          }
        } else if (body.id) {
          state.pendingAttention = (state.pendingAttention || []).filter((x) => x.id !== body.id);
        }
      });
      if (wsReal && body.id) {
        ackInboxItems(dataDir, wsReal, { id: body.id });
      }
      if (body.kind === 'handover' && wsReal && body.ignoreForSession !== false) {
        cleanupWorkspaceInbox(dataDir, wsReal, { activeControllerId: ctrlId, handoverIgnored: true });
      }
      return this.#sendJson(res, 200, {
        ok: true,
        snapshot: this.#buildSnapshot(wsReal || ''),
      });
    }

    if (url.pathname === '/api/diagnostics/clear') {
      clearFlightLogs(dataDir);
      return this.#sendJson(res, 200, {
        ok: true,
        summary: summarizeFlightEvents(dataDir),
        events: [],
      });
    }

    if (url.pathname === '/api/cache/clear') {
      const wsReal = body.workspace
        ? normalizeWorkspaceInput(body.workspace, { throwOnInvalid: false })
        : '';
      this.#transcriptCache = {};
      this.#invalidateMultiWsCache();
      clearMetadataCache();
      updatePluginState(dataDir, (state) => {
        state.transcriptCache = {};
      });
      return this.#sendJson(res, 200, {
        ok: true,
        snapshot: this.#buildSnapshot(wsReal || ''),
      });
    }

    if (url.pathname === '/api/dispatch/create') {
      const wsReal = body.workspace
        ? normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true })
        : '';
      return await this.#withWorkspaceMutex(wsReal, async () => {
        const resolved = resolveEffectiveSettings({
          dataDir,
          wsReal: wsReal || '',
          pluginRoot: PLUGIN_ROOT,
          env: process.env,
        });
        const chosenModel = String(body.model || resolved.effective.l2StandardModel || '').trim();
        const check = validateDispatchModel(chosenModel, resolved.effective);
        if (!check.ok) {
          throw new HttpError(403, check.reason);
        }
        const slashPrefix = String(body.slashPrefix || '').trim();
        if (!ALLOWED_SLASH_PREFIXES.has(slashPrefix)) {
          throw new HttpError(400, `Unsupported slashPrefix: ${slashPrefix}`);
        }
        const rawPrompt = String(body.prompt || body.topic || '').trim();
        if (!rawPrompt) {
          throw new HttpError(400, 'prompt or topic is required');
        }

        let regFound = null;
        let parsedReg = null;
        if (wsReal) {
          regFound = findExistingRegistry(wsReal, {
            dataDir,
            workspaceSettings: resolved.workspace,
          });
          if (regFound) {
            const curContent = readFileSync(regFound.absPath, 'utf8');
            const curHash = sha256(curContent);
            if (body.expectedHash && body.expectedHash !== curHash) {
              throw new HttpError(409, '台账已被外部会话修改，请重载最新内容后再派遣。', {
                currentHash: curHash,
                content: curContent,
              });
            }
            parsedReg = parseRegistry(curContent);
          }
        }

        const lockStatus =
          resolved.effective.exclusiveLeaseEnabled === false
            ? '无独占资源限制'
            : String(body.lockStatus || '纯离线无锁').trim();
        const wantsExclusiveLock =
          resolved.effective.exclusiveLeaseEnabled !== false &&
          /^持独占锁|^LOCKED/i.test(lockStatus);

        if (wantsExclusiveLock && parsedReg && !isLeaseIdle(parsedReg.lease?.lockStatus || '')) {
          throw new HttpError(
            409,
            `当前工作区独占资源已被占用 (${parsedReg.lease?.holder || parsedReg.lease?.lockStatus})，请先释放租约或改为纯离线无锁派遣`
          );
        }

        const cliModel = normalizeModelForAgentApi(check.model);
        const rawCtrl = String(parsedReg?.controller?.currentControllerId || '').trim();
        const ctrlId = isValidConvIdOrPrefix(rawCtrl) ? rawCtrl : '';
        const finalMessage = buildDispatchPayload({
          prompt: rawPrompt,
          slashPrefix,
          controllerId: ctrlId,
          exclusiveLeaseEnabled: resolved.effective.exclusiveLeaseEnabled,
          lockStatus,
          registryRelPath: regFound?.relPath || '.agents/SESSION-REGISTRY.md',
        });

        const title = String(body.title || body.topic || '').trim();
        const args = ['new-conversation', '--model', cliModel];
        if (title) args.push('--title', title);
        args.push(safePositionalMessage(finalMessage));
        const apiResult = await execAgentApiAsync(args, { projectId: body.projectId });
        const newConvId = extractConversationIdFromResult(apiResult);

        let enrolled = false;
        if (newConvId && regFound) {
          let nextMd = readFileSync(regFound.absPath, 'utf8');
          const topicLabel = String(body.topic || title || rawPrompt.slice(0, 48)).trim();
          if (wantsExclusiveLock) {
            try {
              nextMd = updateLeaseSection(nextMd, {
                lockStatus: 'LOCKED（独占占用中）',
                holder: newConvId,
                since: new Date().toISOString().slice(0, 16).replace('T', ' '),
              });
            } catch {
              // ignore non-standard Section 1
            }
          }
          nextMd = upsertActiveSessionRow(nextMd, {
            conversationId: newConvId,
            topic: topicLabel,
            modelTool: slashPrefix ? `${check.model} + ${slashPrefix}` : check.model,
            lockStatus,
            status: 'ACTIVE',
            paths: String(body.paths || '-').trim() || '-',
          });
          atomicWriteText(regFound.absPath, nextMd.endsWith('\n') ? nextMd : `${nextMd}\n`);
          enrolled = true;
        }

        if (newConvId && wsReal && body.workstreamId) {
          try {
            updateRoadmapNodeStatus(
              wsReal,
              { id: body.workstreamId, status: 'active', linkedConvId: newConvId },
              { dataDir, workspaceSettings: resolved.workspace }
            );
          } catch {
            // ignore roadmap link mismatch
          }
        }

        this.#logFlightSafe({
          level: 'info',
          source: 'sidecar',
          event: 'dispatch_created',
          conv: newConvId,
          message: `Dispatched worker via ${cliModel}`,
          detail: { cliModel, enrolled, hasSlash: Boolean(slashPrefix), workstreamId: body.workstreamId || '' },
        });

        return this.#sendJson(res, 200, {
          ok: true,
          conversationId: newConvId,
          cliModel,
          enrolled,
          result: apiResult,
          snapshot: this.#buildSnapshot(wsReal || ''),
        });
      });
    }

    if (url.pathname === '/api/registry/init') {
      const wsReal = normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true });
      if (!wsReal) throw new HttpError(400, 'workspace is required');
      return await this.#withWorkspaceMutex(wsReal, async () => {
        const relPath = String(body.relPath || '.agents/SESSION-REGISTRY.md').trim();
        const isStandard =
          relPath === '.agents/SESSION-REGISTRY.md' ||
          relPath === 'research/SESSION-REGISTRY.md' ||
          relPath === 'SESSION-REGISTRY.md';
        const isManaged = relPath === MANAGED_REGISTRY_VIRTUAL_REL;
        const target = resolveRegistryTarget(wsReal, relPath, {
          allowMissing: true,
          dataDir,
          allowCustomRel: !isStandard && !isManaged,
        });
        if (existsSync(target)) {
          throw new HttpError(409, `Target already exists: ${relPath}`);
        }
        const resolved = resolveEffectiveSettings({
          dataDir,
          wsReal,
          pluginRoot: PLUGIN_ROOT,
          env: process.env,
        });
        const { registrySkeleton } = extractTemplatesFromMarkdown(
          resolved.docs['templates.md']?.content || ''
        );
        atomicWriteText(target, `${registrySkeleton.trimEnd()}\n`);
        if (isManaged) {
          saveWorkspaceSettings(dataDir, wsReal, { registryMode: 'plugin_data' });
        } else if (!isStandard) {
          saveWorkspaceSettings(dataDir, wsReal, {
            registryMode: 'workspace_custom',
            customRegistryRelPath: relPath,
          });
        }
        this.#activeWorkspace = wsReal;
        const nextRecent = recordRecentWorkspace(wsReal);
        this.#sseHub.trackWorkspace(wsReal, dataDir);
        this.#ensureSentinelTimer();
        return this.#sendJson(res, 200, {
          ok: true,
          snapshot: this.#buildSnapshot(wsReal, { recentOverride: nextRecent }),
        });
      });
    }

    if (url.pathname === '/api/lease/update') {
      const { wsReal, target, content } = this.#loadRegistryForMutation(body);
      const patch =
        body.action === 'release'
          ? {
              lockStatus: 'IDLE（空闲待分配）',
              holder: '-',
              since: '-',
              ...(body.resource !== undefined ? { resource: body.resource } : {}),
              ...(body.scope !== undefined ? { scope: body.scope } : {}),
              ...(body.releaseCriteria !== undefined
                ? { releaseCriteria: body.releaseCriteria }
                : {}),
            }
          : {
              lockStatus: body.lockStatus,
              holder: body.holder,
              resource: body.resource,
              since: body.since,
              scope: body.scope,
              releaseCriteria: body.releaseCriteria,
            };
      const next = updateLeaseSection(content, patch);
      atomicWriteText(target.absPath, next.endsWith('\n') ? next : `${next}\n`);
      return this.#sendJson(res, 200, { ok: true, snapshot: this.#buildSnapshot(wsReal) });
    }

    if (url.pathname === '/api/controller/update') {
      const { wsReal, target, content } = this.#loadRegistryForMutation(body);
      const next = updateControllerSection(content, {
        controllerId: body.controllerId,
        status: body.status,
        defaultModel: body.defaultModel,
        appendHistory: Boolean(body.appendHistory),
        period: body.period,
        summary: body.summary,
      });
      atomicWriteText(target.absPath, next.endsWith('\n') ? next : `${next}\n`);
      return this.#sendJson(res, 200, { ok: true, snapshot: this.#buildSnapshot(wsReal) });
    }

    if (url.pathname === '/api/sessions/upsert') {
      const { wsReal, target, content } = this.#loadRegistryForMutation(body);
      const next = upsertActiveSessionRow(content, {
        conversationId: body.conversationId,
        topic: body.topic,
        modelTool: body.modelTool,
        lockStatus: body.lockStatus,
        status: body.status,
        paths: body.paths,
      });
      atomicWriteText(target.absPath, next.endsWith('\n') ? next : `${next}\n`);
      return this.#sendJson(res, 200, { ok: true, snapshot: this.#buildSnapshot(wsReal) });
    }

    if (url.pathname === '/api/sessions/archive') {
      const { wsReal, target, content } = this.#loadRegistryForMutation(body);
      const next = archiveActiveSession(content, {
        conversationId: body.conversationId,
        milestone: body.milestone,
        summary: body.summary,
      });
      atomicWriteText(target.absPath, next.endsWith('\n') ? next : `${next}\n`);
      return this.#sendJson(res, 200, { ok: true, snapshot: this.#buildSnapshot(wsReal) });
    }

    if (url.pathname === '/api/queue/upsert') {
      const { wsReal, target, content } = this.#loadRegistryForMutation(body);
      const next = upsertQueueRow(content, body);
      atomicWriteText(target.absPath, next.endsWith('\n') ? next : `${next}\n`);
      return this.#sendJson(res, 200, { ok: true, snapshot: this.#buildSnapshot(wsReal) });
    }

    if (url.pathname === '/api/queue/delete') {
      const { wsReal, target, content } = this.#loadRegistryForMutation(body);
      const next = deleteQueueRow(content, body.id);
      atomicWriteText(target.absPath, next.endsWith('\n') ? next : `${next}\n`);
      return this.#sendJson(res, 200, { ok: true, snapshot: this.#buildSnapshot(wsReal) });
    }

    if (url.pathname === '/api/registry/save') {
      const { wsReal, target } = this.#loadRegistryForMutation(body);
      if (typeof body.content !== 'string') {
        throw new HttpError(400, 'content must be a string');
      }
      if (Buffer.byteLength(body.content, 'utf8') > MAX_FILE_BYTES) {
        throw new HttpError(413, 'SESSION-REGISTRY.md exceeds 512KB cap');
      }
      atomicWriteText(target.absPath, body.content);
      return this.#sendJson(res, 200, { ok: true, snapshot: this.#buildSnapshot(wsReal) });
    }

    return this.#sendJson(res, 404, { error: 'Not Found' });
  }

  start() {
    const preloadJs = findPreloadJs();
    const server = createServer(async (req, res) => {
      try {
        const rawUrl = String(req.url || '/');
        const safePath = rawUrl.startsWith('//') ? `/${rawUrl.replace(/^\/+/, '')}` : rawUrl;
        let url;
        try {
          url = new URL(safePath, 'http://127.0.0.1');
        } catch {
          return this.#sendJson(res, 400, { error: 'bad_request', message: 'Malformed request URL' });
        }

        const isProtectedRoute =
          url.pathname.startsWith('/api/') || url.pathname.startsWith('/_sidecar/');

        if (isProtectedRoute && req.method === 'POST' && !this.#validOrigin(req)) {
          return this.#sendJson(res, 403, { error: 'forbidden_origin' });
        }

        if (isProtectedRoute && !this.#validToken(req, url)) {
          const d = getDataDir();
          const nowMs = Date.now();
          if (existsSync(d) && nowMs - this.#lastAuthRejectLogAt >= 1000) {
            this.#lastAuthRejectLogAt = nowMs;
            this.#logFlightSafe(
              {
                level: 'warn',
                source: 'sidecar',
                event: 'auth_rejected',
                ok: false,
                message: `401 unauthorized on ${req.method} ${url.pathname}`,
              },
              { allowCreate: false }
            );
          }
          return this.#sendJson(res, 401, { error: 'unauthorized' });
        }

        const isReadMethod = req.method === 'GET' || req.method === 'HEAD';

        if (isReadMethod && url.pathname === '/preload.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', ...NO_STORE_HEADERS });
          res.end(req.method === 'HEAD' ? undefined : preloadJs);
          return;
        }

        if (isReadMethod && url.pathname === '/app.bundle.js') {
          try {
            const bundle = this.#getClassicBundle();
            res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', ...NO_STORE_HEADERS });
            res.end(req.method === 'HEAD' ? undefined : bundle.code);
          } catch (err) {
            this.#logFlightSafe(
              {
                level: 'error',
                source: 'sidecar',
                event: 'static_asset_error',
                ok: false,
                message: err?.message || 'Failed building /app.bundle.js',
              },
              { allowCreate: false }
            );
            this.#sendJson(res, 500, { error: err?.message || 'bundle_error' });
          }
          return;
        }

        if (isReadMethod && this.#staticAssets.has(url.pathname)) {
          const asset = this.#staticAssets.get(url.pathname);
          try {
            if (url.pathname === '/' || url.pathname === '/index.html') {
              const cssStamp = computeAssetStamp(join(__dirname, 'styles.css'));
              const guardStamp = computeAssetStamp(join(__dirname, 'boot-guard.js'));
              const bundle = this.#getClassicBundle();
              const html = readFileSync(asset.file, 'utf8')
                .replace('/styles.css', `/styles.css?v=${cssStamp}`)
                .replace('/boot-guard.js', `/boot-guard.js?v=${guardStamp}`)
                .replace('/app.bundle.js', `/app.bundle.js?v=${bundle.stamp}`);
              res.writeHead(200, { 'Content-Type': asset.type, ...NO_STORE_HEADERS });
              res.end(req.method === 'HEAD' ? undefined : html);
              return;
            }
            const buf = readFileSync(asset.file);
            res.writeHead(200, { 'Content-Type': asset.type, ...NO_STORE_HEADERS });
            res.end(req.method === 'HEAD' ? undefined : buf);
          } catch (err) {
            this.#logFlightSafe(
              {
                level: 'error',
                source: 'sidecar',
                event: 'static_asset_error',
                ok: false,
                message: err?.message || `Failed reading ${url.pathname}`,
              },
              { allowCreate: false }
            );
            this.#sendJson(res, 500, { error: err?.message || 'asset_error' });
          }
          return;
        }

        if (url.pathname.startsWith('/_sidecar/')) {
          const t0 = Date.now();
          try {
            await this.#handleSidecarBridge(req, res, url);
            const elapsed = Date.now() - t0;
            if (elapsed >= SLOW_RPC_THRESHOLD_MS) {
              this.#logFlightSafe({
                level: 'warn',
                source: 'sidecar',
                event: 'slow_rpc',
                durationMs: elapsed,
                message: `${req.method} ${url.pathname} took ${elapsed}ms`,
              });
            }
          } catch (err) {
            if (err instanceof HttpError || err instanceof PathError) {
              if (err.status >= 400) {
                this.#logFlightSafe({
                  level: err.status >= 500 ? 'error' : 'warn',
                  source: 'sidecar',
                  event: 'bridge_error',
                  ok: false,
                  durationMs: Date.now() - t0,
                  message: `${err.status} ${url.pathname}: ${err.message}`,
                });
              }
              const extraHdr = err.status === 413 ? { Connection: 'close' } : {};
              return this.#sendJson(
                res,
                err.status,
                {
                  error: err.extra?.error || 'error',
                  message: err.message,
                  ...(err.extra || {}),
                },
                extraHdr
              );
            }
            this.#logFlightSafe({
              level: 'error',
              source: 'sidecar',
              event: 'bridge_internal_error',
              ok: false,
              durationMs: Date.now() - t0,
              message: `${url.pathname}: ${err?.message || 'internal error'}`,
            });
            return this.#sendJson(res, 500, {
              error: 'internal',
              message: err?.message || 'internal error',
            });
          }
          return;
        }

        if (url.pathname.startsWith('/api/')) {
          const t0 = Date.now();
          const allowLogCreate = req.method !== 'GET';
          const isEventStream = url.pathname === '/api/events';
          const slowThreshold = RPC_API_ROUTES.has(url.pathname)
            ? SLOW_RPC_THRESHOLD_MS
            : SLOW_OP_THRESHOLD_MS;
          try {
            if (req.method === 'POST') {
              this.#invalidateMultiWsCache();
            }
            await this.#handleApi(req, res, url);
            if (req.method === 'POST' && res.statusCode < 400) {
              this.#invalidateMultiWsCache();
              this.#sseHub.notify({ workspace: this.#activeWorkspace, reason: url.pathname });
            }
            const elapsed = Date.now() - t0;
            if (!isEventStream && elapsed >= slowThreshold && url.pathname !== '/api/diagnostics') {
              this.#logFlightSafe(
                {
                  level: 'warn',
                  source: 'sidecar',
                  event: RPC_API_ROUTES.has(url.pathname) ? 'slow_rpc' : 'slow_api',
                  durationMs: elapsed,
                  message: `${req.method} ${url.pathname} took ${elapsed}ms`,
                },
                { allowCreate: allowLogCreate }
              );
            }
          } catch (err) {
            if (err instanceof HttpError || err instanceof PathError) {
              if (err.status >= 400) {
                this.#logFlightSafe(
                  {
                    level: err.status >= 500 ? 'error' : 'warn',
                    source: 'sidecar',
                    event: 'api_error',
                    ok: false,
                    durationMs: Date.now() - t0,
                    message: `${err.status} ${url.pathname}: ${err.message}`,
                  },
                  { allowCreate: allowLogCreate }
                );
              }
              const extraHdr = err.status === 413 ? { Connection: 'close' } : {};
              return this.#sendJson(
                res,
                err.status,
                {
                  error: err.extra?.error || 'error',
                  message: err.message,
                  ...(err.extra || {}),
                },
                extraHdr
              );
            }
            this.#logFlightSafe(
              {
                level: 'error',
                source: 'sidecar',
                event: 'api_internal_error',
                ok: false,
                durationMs: Date.now() - t0,
                message: `${url.pathname}: ${err?.message || 'internal error'}`,
              },
              { allowCreate: allowLogCreate }
            );
            return this.#sendJson(res, 500, {
              error: 'internal',
              message: err?.message || 'internal error',
            });
          }
          return;
        }

        this.#sendJson(res, 404, { error: 'Not Found' });
      } catch (outerErr) {
        this.#sendJson(res, 500, {
          error: 'internal',
          message: outerErr?.message || 'Unhandled server error',
        });
      }
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 15000;

    this.#server = server;
    return new Promise((resolveListen) => {
      server.listen(this.#port, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          console.log(`control-tower sidecar listening on http://127.0.0.1:${addr.port}`);
        }
        resolveListen({ server, port: addr?.port || this.#port });
      });
    });
  }

  close() {
    this.#sseHub.close();
    if (this.#sentinelTimer) {
      clearInterval(this.#sentinelTimer);
      this.#sentinelTimer = null;
    }
    return new Promise((resolveClose) => {
      if (this.#server) {
        this.#server.closeAllConnections?.();
        this.#server.close(() => resolveClose());
      } else {
        resolveClose();
      }
    });
  }
}

export { ControlTowerServer };

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  new ControlTowerServer().start();
}
