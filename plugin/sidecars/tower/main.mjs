import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atomicWriteText,
  findExistingRegistry,
  MANAGED_REGISTRY_VIRTUAL_REL,
  normalizeWorkspaceInput,
  PathError,
  readJsonSafe,
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
  inspectNativeSwarm,
  inspectTranscript,
  loadPluginState,
  resolveBrainTranscript,
  savePluginState,
} from '../../lib/transcript.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..', '..');

const MAX_FILE_BYTES = 512 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CACHE_ENTRIES = 200;
const UUID_EXTRACT_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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
    version: raw?.version || '1.2.0',
  };
}

function loadRecentWorkspaces() {
  const recentPath = getRecentPath();
  const raw = readJsonSafe(recentPath, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => typeof item === 'string' && existsSync(item));
}

function recordRecentWorkspace(wsReal) {
  try {
    const existing = loadRecentWorkspaces().filter((p) => p !== wsReal);
    const next = [wsReal, ...existing].slice(0, 12);
    atomicWriteText(getRecentPath(), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  } catch {
    return [wsReal];
  }
}

function execAgentApi(args, { projectId } = {}) {
  const env = { ...process.env };
  if (projectId) env.ANTIGRAVITY_PROJECT_ID = projectId;
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  const file = exe || 'agentapi';
  const execArgs = exe ? ['agentapi', ...args] : args;
  const out = execFileSync(file, execArgs, { encoding: 'utf8', env });
  return out && out.trim() ? JSON.parse(out) : {};
}

function extractConversationIdFromResult(res) {
  if (!res || typeof res !== 'object') return '';
  const direct =
    res.conversationId ||
    res.conversation_id ||
    res.id ||
    res.response?.conversationId ||
    res.response?.conversation_id ||
    res.result?.conversationId;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }
  const m = JSON.stringify(res).match(UUID_EXTRACT_RE);
  return m ? m[0] : '';
}

function buildDispatchPayload({
  prompt,
  slashPrefix = '',
  controllerId = '',
  exclusiveLeaseEnabled = true,
  lockStatus = '纯离线无锁',
  registryRelPath = '.agents/SESSION-REGISTRY.md',
}) {
  let body = String(prompt || '').trim();
  const prefix = String(slashPrefix || '').trim();
  if (prefix && !body.startsWith(prefix)) {
    body = `${prefix} ${body}`;
  }
  if (!controllerId || body.includes('[CT_REPORT:')) {
    return body;
  }
  const lockLine = exclusiveLeaseEnabled
    ? `当前资源锁约束: ${lockStatus || '纯离线无锁'}。`
    : '当前工作区处于无独占资源模式。';
  return (
    `${body}\n\n` +
    `【Control Tower 跨会话汇报锚点（现役总控: ${controllerId}）】\n` +
    `1. ${lockLine}严禁直接改写 ${registryRelPath}。\n` +
    `2. 遇需要拍板的架构/接口/范围分叉或连续两轮假设失败时，执行：\n` +
    `   agentapi send-message "${controllerId}" "[CT_REPORT:DECISION] <分叉简述与备选方案>"\n` +
    `3. 完成收口时汇报交付摘要与验证结果：\n` +
    `   agentapi send-message "${controllerId}" "[CT_REPORT:DONE] <交付摘要与验证结论>"`
  );
}

class ControlTowerServer {
  #port;
  #token;
  #staticAssets;
  #transcriptCache;
  #server;

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
    this.#staticAssets = new Map([
      ['/', { file: join(__dirname, 'index.html'), type: 'text/html; charset=utf-8' }],
      ['/index.html', { file: join(__dirname, 'index.html'), type: 'text/html; charset=utf-8' }],
      ['/styles.css', { file: join(__dirname, 'styles.css'), type: 'text/css; charset=utf-8' }],
      ['/app.js', { file: join(__dirname, 'app.js'), type: 'application/javascript; charset=utf-8' }],
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
    const provided = req.headers['x-sidecar-token'] || url.searchParams.get('token');
    return provided === this.#token;
  }

  #sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }

  async #readBody(req) {
    return await new Promise((resolveBody, rejectBody) => {
      const chunks = [];
      let total = 0;
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          rejectBody(new HttpError(413, 'Request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) return resolveBody({});
        try {
          const parsed = JSON.parse(raw);
          resolveBody(parsed && typeof parsed === 'object' ? parsed : {});
        } catch {
          rejectBody(new HttpError(400, 'Invalid JSON body'));
        }
      });
      req.on('error', (err) => rejectBody(err));
    });
  }

  #buildAttention(dataDir, wsReal, parsed, resolved) {
    const pluginState = loadPluginState(dataDir);
    const ctrlId = String(parsed?.controller?.currentControllerId || '').trim();
    const ctrlEntry = ctrlId ? pluginState.controllers?.[ctrlId] || {} : {};
    const handoverIgnored = Boolean(ctrlEntry.handoverIgnored);
    const items = [];
    const seen = new Set();

    for (const item of pluginState.pendingAttention || []) {
      if (!item || !item.id) continue;
      if (item.workspace && wsReal && item.workspace !== wsReal) continue;
      if (item.kind === 'handover' && handoverIgnored) continue;
      items.push(item);
      seen.add(item.id);
    }

    const comps = Number(parsed?.controller?.telemetry?.compactions || 0);
    const threshold = resolved.effective.controllerCompactionThreshold || 5;
    if (ctrlId && !handoverIgnored && comps >= threshold) {
      const liveId = `handover-${ctrlId.slice(0, 8)}`;
      if (!seen.has(liveId)) {
        items.push({
          id: liveId,
          kind: 'handover',
          workspace: wsReal || '',
          controllerId: ctrlId,
          compactions: comps,
          threshold,
          summary: `总控已累计压缩 ${comps} 次（阈值 ${threshold} 次），可选择换届或本会话忽略`,
          updatedAt: Date.now(),
        });
      }
    }

    return { items, handoverIgnored };
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

    if (!wsReal) {
      return {
        plugin,
        workspace: '',
        recentWorkspaces: recent,
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
        attention: { items: [], handoverIgnored: false },
      };
    }

    const found = findExistingRegistry(wsReal, {
      dataDir,
      workspaceSettings: resolved.workspace,
    });
    if (!found) {
      return {
        plugin,
        workspace: wsReal,
        recentWorkspaces: recent,
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
        attention: { items: [], handoverIgnored: false },
      };
    }

    const content = readFileSync(found.absPath, 'utf8');
    const parsed = parseRegistry(content);
    if (parsed.controller.currentControllerId) {
      parsed.controller.telemetry = inspectById(parsed.controller.currentControllerId, {
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

    const nativeSwarm = parsed.controller.currentControllerId
      ? inspectNativeSwarm(parsed.controller.currentControllerId, {
          env: process.env,
          cacheMap: this.#transcriptCache,
        })
      : emptySwarm;
    this.#pruneCache();

    const attention = this.#buildAttention(dataDir, wsReal, parsed, resolved);

    return {
      plugin,
      workspace: wsReal,
      recentWorkspaces: recent,
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
      attention,
    };
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
      const wsReal = body.workspace
        ? normalizeWorkspaceInput(body.workspace, { throwOnInvalid: false })
        : '';
      const resolved = resolveEffectiveSettings({
        dataDir: getDataDir(),
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
      args.push(message);
      const result = execAgentApi(args, { projectId: body.projectId });
      return this.#sendJson(res, 200, { ok: true, cliModel, result });
    }
    if (url.pathname === '/_sidecar/get-conversation-metadata') {
      const convId = String(body.conversationId || '').trim();
      if (!convId) throw new HttpError(400, 'conversationId is required');
      const result = execAgentApi(['get-conversation-metadata', convId]);
      return this.#sendJson(res, 200, result);
    }
    if (url.pathname === '/_sidecar/send-message') {
      const convId = String(body.conversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || '').trim();
      const message = String(body.message || '').trim();
      if (!convId || !message) {
        throw new HttpError(400, 'conversationId and message are required');
      }
      const args = ['send-message'];
      if (body.title) args.push('--title', String(body.title));
      args.push(convId, message);
      const result = execAgentApi(args, { projectId: body.projectId });
      return this.#sendJson(res, 200, result);
    }
    return this.#sendJson(res, 404, { error: 'Not Found' });
  }

  async #handleApi(req, res, url) {
    const dataDir = getDataDir();

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

    if (req.method !== 'POST') {
      return this.#sendJson(res, 405, { error: 'Method Not Allowed' });
    }

    const body = await this.#readBody(req);

    if (url.pathname === '/api/workspace/select') {
      const wsReal = normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true });
      if (!wsReal) throw new HttpError(400, 'workspace is required');
      const nextRecent = recordRecentWorkspace(wsReal);
      const snap = this.#buildSnapshot(wsReal, { recentOverride: nextRecent });
      return this.#sendJson(res, 200, { ok: true, snapshot: snap });
    }

    if (url.pathname === '/api/settings/plugin') {
      const next =
        body.action === 'reset' ? resetPluginSettings(dataDir) : savePluginSettings(dataDir, body);
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
      const state = loadPluginState(dataDir);
      if (body.kind === 'handover') {
        let ctrlId = String(body.controllerId || '').trim();
        if (!ctrlId && wsReal) {
          const found = findExistingRegistry(wsReal, { dataDir });
          if (found) {
            const parsed = parseRegistry(readFileSync(found.absPath, 'utf8'));
            ctrlId = parsed?.controller?.currentControllerId || '';
          }
        }
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
      savePluginState(dataDir, state);
      return this.#sendJson(res, 200, {
        ok: true,
        snapshot: this.#buildSnapshot(wsReal || ''),
      });
    }

    if (url.pathname === '/api/cache/clear') {
      const wsReal = body.workspace
        ? normalizeWorkspaceInput(body.workspace, { throwOnInvalid: false })
        : '';
      const state = loadPluginState(dataDir);
      state.transcriptCache = {};
      this.#transcriptCache = {};
      savePluginState(dataDir, state);
      return this.#sendJson(res, 200, {
        ok: true,
        snapshot: this.#buildSnapshot(wsReal || ''),
      });
    }

    if (url.pathname === '/api/dispatch/create') {
      const wsReal = body.workspace
        ? normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true })
        : '';
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

      const cliModel = normalizeModelForAgentApi(check.model);
      const ctrlId = String(parsedReg?.controller?.currentControllerId || '').trim();
      const lockStatus =
        resolved.effective.exclusiveLeaseEnabled === false
          ? '无独占资源限制'
          : String(body.lockStatus || '纯离线无锁').trim();
      const finalMessage = buildDispatchPayload({
        prompt: rawPrompt,
        slashPrefix: body.slashPrefix,
        controllerId: ctrlId,
        exclusiveLeaseEnabled: resolved.effective.exclusiveLeaseEnabled,
        lockStatus,
        registryRelPath: regFound?.relPath || '.agents/SESSION-REGISTRY.md',
      });

      const title = String(body.title || body.topic || '').trim();
      const args = ['new-conversation', '--model', cliModel];
      if (title) args.push('--title', title);
      args.push(finalMessage);
      const apiResult = execAgentApi(args, { projectId: body.projectId });
      const newConvId = extractConversationIdFromResult(apiResult);

      let enrolled = false;
      if (newConvId && regFound) {
        const latestContent = readFileSync(regFound.absPath, 'utf8');
        const nextMd = upsertActiveSessionRow(latestContent, {
          conversationId: newConvId,
          topic: String(body.topic || title || rawPrompt.slice(0, 48)).trim(),
          modelTool: body.slashPrefix ? `${check.model} + ${String(body.slashPrefix).trim()}` : check.model,
          lockStatus,
          status: 'ACTIVE',
          paths: String(body.paths || '-').trim() || '-',
        });
        atomicWriteText(regFound.absPath, nextMd.endsWith('\n') ? nextMd : `${nextMd}\n`);
        enrolled = true;
      }

      return this.#sendJson(res, 200, {
        ok: true,
        conversationId: newConvId,
        cliModel,
        enrolled,
        result: apiResult,
        snapshot: this.#buildSnapshot(wsReal || ''),
      });
    }

    if (url.pathname === '/api/registry/init') {
      const wsReal = normalizeWorkspaceInput(body.workspace, { throwOnInvalid: true });
      if (!wsReal) throw new HttpError(400, 'workspace is required');
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
      const nextRecent = recordRecentWorkspace(wsReal);
      return this.#sendJson(res, 200, {
        ok: true,
        snapshot: this.#buildSnapshot(wsReal, { recentOverride: nextRecent }),
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
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      const isProtectedRoute =
        url.pathname.startsWith('/api/') || url.pathname.startsWith('/_sidecar/');

      if (isProtectedRoute && !this.#validToken(req, url)) {
        return this.#sendJson(res, 401, { error: 'unauthorized' });
      }

      if (req.method === 'GET' && url.pathname === '/preload.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(preloadJs);
        return;
      }

      if (req.method === 'GET' && this.#staticAssets.has(url.pathname)) {
        const asset = this.#staticAssets.get(url.pathname);
        try {
          const buf = readFileSync(asset.file);
          res.writeHead(200, { 'Content-Type': asset.type });
          res.end(buf);
        } catch (err) {
          this.#sendJson(res, 500, { error: err.message });
        }
        return;
      }

      if (url.pathname.startsWith('/_sidecar/')) {
        try {
          await this.#handleSidecarBridge(req, res, url);
        } catch (err) {
          if (err instanceof HttpError || err instanceof PathError) {
            return this.#sendJson(res, err.status, {
              error: err.extra?.error || 'error',
              message: err.message,
              ...(err.extra || {}),
            });
          }
          return this.#sendJson(res, 500, { error: 'internal', message: err.message });
        }
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        try {
          await this.#handleApi(req, res, url);
        } catch (err) {
          if (err instanceof HttpError || err instanceof PathError) {
            return this.#sendJson(res, err.status, {
              error: err.extra?.error || 'error',
              message: err.message,
              ...(err.extra || {}),
            });
          }
          return this.#sendJson(res, 500, { error: 'internal', message: err.message });
        }
        return;
      }

      this.#sendJson(res, 404, { error: 'Not Found' });
    });

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
    return new Promise((resolveClose) => {
      if (this.#server) {
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
