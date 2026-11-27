import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { loadWorkspaceInbox, recordControllerFocus, setDeferredReceipt } from '../plugin/lib/inbox.mjs';
import { MANAGED_REGISTRY_VIRTUAL_REL } from '../plugin/lib/paths.mjs';
import { ControlTowerServer } from '../plugin/sidecars/tower/main.mjs';
import { makeConvId, makeSandbox, makeTranscriptPath } from './helpers.mjs';

test('Sidecar enforces token auth, zero-write GET, CRUD, 3-tier settings, managed registry, and controlled dispatch', async () => {
  const sb = makeSandbox();
  const prevEnv = { ...process.env };
  let server;
  try {
    const ws = join(sb.dir, 'ws');
    const wsClean = join(sb.dir, 'ws_clean');
    const appDir = join(sb.dir, 'app');
    const dataDir = join(sb.dir, 'plugin_data');
    mkdirSync(ws, { recursive: true });
    mkdirSync(wsClean, { recursive: true });
    mkdirSync(join(appDir, 'brain'), { recursive: true });

    const ctrlId = makeConvId('c', '1', '4', '8', 'a');
    const workerId = makeConvId('a', '9', '4', '8', 'f');
    const dispatchedId = makeConvId('f', '8', '4', '8', 'd');
    const tp = makeTranscriptPath(appDir, workerId);
    writeFileSync(
      tp,
      `${JSON.stringify({
        step_index: 5,
        type: 'USER_INPUT',
        content: '<USER_REQUEST>\nSidecar探针目标\n</USER_REQUEST>',
        model: 'gemini-4-hydrogen-high',
      })}\n`,
      'utf8'
    );

    // Native swarm fixture for active controller
    const swarmDir = join(appDir, 'brain', ctrlId, '.system_generated', 'swarm');
    mkdirSync(swarmDir, { recursive: true });
    writeFileSync(
      join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Sidecar Swarm',
        members: {
          coder: { conversation_id: workerId, model: 'gemini-4-hydrogen-high', role: 'worker' },
        },
      }),
      'utf8'
    );
    writeFileSync(
      join(swarmDir, 'board.jsonl'),
      `${JSON.stringify({ seq: 1, agent: 'coordinator', text: '@coder go', time: '2026-11-22T00:00:00Z' })}\n`,
      'utf8'
    );

    // Mock agentapi executable supporting both send-message and new-conversation
    const mockExe = join(sb.dir, 'mock-agentapi.mjs');
    const mockLog = join(sb.dir, 'agentapi-calls.json');
    writeFileSync(
      mockExe,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(mockLog)}, JSON.stringify(args), 'utf8');
if (args.includes('new-conversation')) {
  process.stdout.write(JSON.stringify({ ok: true, conversationId: ${JSON.stringify(dispatchedId)}, forwarded: args }));
} else {
  process.stdout.write(JSON.stringify({ ok: true, forwarded: args }));
}
`,
      'utf8'
    );
    chmodSync(mockExe, 0o755);

    const token = 'test-sidecar-token';
    process.env.AGY_CONTROL_TOWER_DATA_DIR = dataDir;
    process.env.ANTIGRAVITY_APP_DATA_DIR = appDir;
    process.env.ANTIGRAVITY_AGENTAPI_EXE = mockExe;

    server = new ControlTowerServer({ port: 0, token });
    const { port } = await server.start();
    const base = `http://127.0.0.1:${port}`;

    async function req(method, path, body = undefined, useToken = true) {
      const headers = {};
      if (useToken) headers['x-sidecar-token'] = token;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data = text;
      try {
        data = JSON.parse(text);
      } catch {
        // plain asset
      }
      return { status: res.status, data };
    }

    // 1) Static assets accessible without token + include defense-in-depth security headers
    const rootAssetRes = await fetch(`${base}/`);
    assert.equal(rootAssetRes.status, 200);
    assert.equal(rootAssetRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(rootAssetRes.headers.get('referrer-policy'), 'no-referrer');
    await rootAssetRes.text();
    assert.equal((await req('GET', '/styles.css', undefined, false)).status, 200);
    assert.equal((await req('GET', '/app.js', undefined, false)).status, 200);
    assert.equal((await req('GET', '/preload.js', undefined, false)).status, 200);

    // 2) Both GET and POST /api/* + /_sidecar/* require valid token -> 401 without token
    assert.equal((await req('GET', `/api/snapshot?workspace=${encodeURIComponent(ws)}`, undefined, false)).status, 401);
    assert.equal((await req('GET', `/api/settings?workspace=${encodeURIComponent(ws)}`, undefined, false)).status, 401);
    assert.equal((await req('GET', `/api/session/inspect?id=${workerId.slice(0, 8)}`, undefined, false)).status, 401);
    assert.equal((await req('POST', '/api/registry/init', { workspace: ws }, false)).status, 401);
    assert.equal((await req('POST', '/_sidecar/send-message', { conversationId: ctrlId, message: 'hi' }, false)).status, 401);

    // 2b) Strict Origin, Sec-Fetch-Site, and DNS-rebinding Host guards block subdomain/rebind attacks
    async function rawHttpStatus(path, { method = 'GET', headers = {}, body = '' } = {}) {
      return await new Promise((resolveStatus, rejectErr) => {
        const r = httpRequest(
          { hostname: '127.0.0.1', port, path, method, headers },
          (resp) => {
            resp.resume();
            resp.on('end', () => resolveStatus(resp.statusCode));
          }
        );
        r.on('error', rejectErr);
        if (body) r.write(body);
        r.end();
      });
    }
    assert.equal(
      await rawHttpStatus('/api/registry/init', {
        method: 'POST',
        headers: {
          'x-sidecar-token': token,
          Origin: 'http://127.0.0.1.evil.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ workspace: ws }),
      }),
      403
    );
    assert.equal(
      await rawHttpStatus('/api/registry/init', {
        method: 'POST',
        headers: {
          'x-sidecar-token': token,
          Origin: 'http://localhost.evil.example:8080',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ workspace: ws }),
      }),
      403
    );
    assert.equal(
      await rawHttpStatus(`/api/snapshot?workspace=${encodeURIComponent(ws)}`, {
        method: 'GET',
        headers: { 'x-sidecar-token': token, 'Sec-Fetch-Site': 'cross-site' },
      }),
      403
    );
    assert.equal(
      await rawHttpStatus(`/api/snapshot?workspace=${encodeURIComponent(ws)}`, {
        method: 'GET',
        headers: { Host: 'rebind.evil.example', 'x-sidecar-token': token },
      }),
      403
    );
    assert.equal(
      await rawHttpStatus(`/api/snapshot?workspace=${encodeURIComponent(ws)}`, {
        method: 'GET',
        headers: { 'x-sidecar-token': token, Origin: 'vscode-webview://aux-pane' },
      }),
      200
    );

    // 3) GET /api/snapshot & GET /api/settings are strictly read-only (zero disk writes)
    const snapBefore = await req('GET', `/api/snapshot?workspace=${encodeURIComponent(ws)}`);
    assert.equal(snapBefore.status, 200);
    assert.equal(snapBefore.data.registryExists, false);
    assert.equal(snapBefore.data.settings.effective.controllerCompactionThreshold, 5);
    assert.equal(existsSync(dataDir), false);

    const setRead = await req('GET', `/api/settings?workspace=${encodeURIComponent(ws)}`);
    assert.equal(setRead.status, 200);
    assert.equal(existsSync(dataDir), false);

    // 4) Explicit workspace select writes recent-workspaces.json
    const selRes = await req('POST', '/api/workspace/select', { workspace: ws });
    assert.equal(selRes.status, 200);
    assert.equal(existsSync(join(dataDir, 'recent-workspaces.json')), true);

    // 5) Init registry & reject duplicate 409
    const init1 = await req('POST', '/api/registry/init', { workspace: ws, relPath: '.agents/SESSION-REGISTRY.md' });
    assert.equal(init1.status, 200);
    assert.equal(init1.data.snapshot.registryExists, true);
    assert.equal((await req('POST', '/api/registry/init', { workspace: ws, relPath: '.agents/SESSION-REGISTRY.md' })).status, 409);

    let h = init1.data.snapshot.hash;

    // 6) Section 2 Controller update + nativeSwarm aggregation
    const cUpd = await req('POST', '/api/controller/update', {
      workspace: ws,
      expectedHash: h,
      controllerId: ctrlId,
      status: 'ONLINE',
      defaultModel: 'Orchestrator (Neon)',
      appendHistory: true,
      summary: 'Sidecar 登记总控',
    });
    assert.equal(cUpd.status, 200);
    assert.equal(cUpd.data.snapshot.parsed.controller.currentControllerId, ctrlId);
    assert.equal(cUpd.data.snapshot.nativeSwarm.active, true);
    assert.equal(cUpd.data.snapshot.nativeSwarm.title, 'Sidecar Swarm');
    h = cUpd.data.snapshot.hash;

    // 7) Section 1 Lease lock + stale hash 409 + release
    const lUpd = await req('POST', '/api/lease/update', {
      workspace: ws,
      expectedHash: h,
      lockStatus: 'LOCKED',
      holder: workerId,
      since: '2026-11-21',
    });
    assert.equal(lUpd.status, 200);
    assert.equal(lUpd.data.snapshot.parsed.lease.lockStatus, 'LOCKED');
    assert.equal((await req('POST', '/api/lease/update', { workspace: ws, expectedHash: h, action: 'release' })).status, 409);

    const lRel = await req('POST', '/api/lease/update', {
      workspace: ws,
      expectedHash: lUpd.data.snapshot.hash,
      action: 'release',
    });
    assert.equal(lRel.status, 200);
    assert.ok(lRel.data.snapshot.parsed.lease.lockStatus.includes('IDLE'));
    h = lRel.data.snapshot.hash;

    // 8) Section 3 Upsert active session -> Section 4 Archive session
    const sUpd = await req('POST', '/api/sessions/upsert', {
      workspace: ws,
      expectedHash: h,
      conversationId: workerId,
      topic: '看板测试任务',
      modelTool: 'Orchestrator (Neon)',
      status: 'ACTIVE',
    });
    assert.equal(sUpd.status, 200);
    assert.equal(sUpd.data.snapshot.parsed.activeSessions.length, 1);

    const sArc = await req('POST', '/api/sessions/archive', {
      workspace: ws,
      expectedHash: sUpd.data.snapshot.hash,
      conversationId: workerId,
      milestone: '看板归档里程碑',
      summary: '端到端验证通过',
    });
    assert.equal(sArc.status, 200);
    assert.equal(sArc.data.snapshot.parsed.activeSessions.length, 0);
    assert.equal(sArc.data.snapshot.parsed.archivedSessions.length, 1);
    h = sArc.data.snapshot.hash;

    // 9) Section 5 Queue upsert/delete + traversal 403
    const qUpd = await req('POST', '/api/queue/upsert', {
      workspace: ws,
      expectedHash: h,
      id: 'T9',
      summary: '测试队列任务',
      status: 'RUNNING',
      route: 'L2 Orchestrator (Neon)',
    });
    assert.equal(qUpd.status, 200);
    const qDel = await req('POST', '/api/queue/delete', {
      workspace: ws,
      expectedHash: qUpd.data.snapshot.hash,
      id: 'T9',
    });
    assert.equal(qDel.status, 200);
    assert.equal(
      (await req('POST', '/api/registry/save', { workspace: ws, relPath: '../etc/passwd', content: 'x' })).status,
      403
    );

    // 10) Controlled /_sidecar/new-conversation + /api/dispatch/create auto-enrollment
    assert.equal((await req('POST', '/_sidecar/new-conversation', { message: 'hello' })).status, 403);
    assert.equal((await req('POST', '/_sidecar/new-conversation', { model: 'flash', message: 'hello' })).status, 403);
    assert.equal((await req('POST', '/_sidecar/new-conversation', { model: 'Gemini 4 Argon (High)', message: 'hello' })).status, 403);

    const allowedBridge = await req('POST', '/_sidecar/new-conversation', {
      workspace: ws,
      model: 'Orchestrator (Neon)',
      title: 'Bridge Spawn',
      message: '执行桥接测试',
    });
    assert.equal(allowedBridge.status, 200);
    assert.equal(allowedBridge.data.cliModel, 'gemini-pro-orchestrator-neon');

    const disp = await req('POST', '/api/dispatch/create', {
      workspace: ws,
      expectedHash: qDel.data.snapshot.hash,
      topic: '直派自动入账测试',
      model: 'Orchestrator (Carbon)',
      slashPrefix: '/plan',
      prompt: '完成核心解析验证',
    });
    assert.equal(disp.status, 200);
    assert.equal(disp.data.cliModel, 'gemini-pro-orchestrator');
    assert.equal(disp.data.conversationId, dispatchedId);
    assert.equal(disp.data.enrolled, true);
    assert.ok(disp.data.snapshot.parsed.activeSessions.some((s) => s.conversationId === dispatchedId));

    // 11) 3-tier settings API + doc override + dismiss handover + cache clear + managed registry
    const psSet = await req('POST', '/api/settings/plugin', {
      workspace: ws,
      livePollIntervalSec: 8,
      registryWriteGuard: 'deny',
    });
    assert.equal(psSet.status, 200);
    assert.equal(psSet.data.snapshot.settings.plugin.livePollIntervalSec, 8);

    const gsSet = await req('POST', '/api/settings/global', {
      workspace: ws,
      controllerCompactionThreshold: 6,
      decisionAutonomy: 'autonomous',
    });
    assert.equal(gsSet.status, 200);
    assert.equal(gsSet.data.snapshot.settings.effective.controllerCompactionThreshold, 6);

    const wsSet = await req('POST', '/api/settings/workspace', {
      workspace: ws,
      exclusiveLeaseEnabled: false,
      overrides: { controllerCompactionThreshold: 3 },
    });
    assert.equal(wsSet.status, 200);
    assert.equal(wsSet.data.snapshot.settings.effective.exclusiveLeaseEnabled, false);
    assert.equal(wsSet.data.snapshot.settings.effective.controllerCompactionThreshold, 3);

    const ovDoc = await req('POST', '/api/settings/override', {
      workspace: ws,
      scope: 'workspace',
      docName: 'model-routing.md',
      content: '# Custom Workspace Routing\n',
    });
    assert.equal(ovDoc.status, 200);
    assert.equal(ovDoc.data.snapshot.settings.docs['model-routing.md'].source, 'workspace');

    const dis = await req('POST', '/api/attention/dismiss', {
      workspace: ws,
      kind: 'handover',
      controllerId: ctrlId,
    });
    assert.equal(dis.status, 200);
    assert.equal(dis.data.snapshot.attention.handoverIgnored, true);

    const cc = await req('POST', '/api/cache/clear', { workspace: ws });
    assert.equal(cc.status, 200);

    // Managed @plugin_data/SESSION-REGISTRY.md on clean workspace leaves zero files inside wsClean
    const initManaged = await req('POST', '/api/registry/init', {
      workspace: wsClean,
      relPath: MANAGED_REGISTRY_VIRTUAL_REL,
    });
    assert.equal(initManaged.status, 200);
    assert.equal(initManaged.data.snapshot.registryIsManaged, true);
    assert.equal(existsSync(join(wsClean, 'SESSION-REGISTRY.md')), false);
    assert.equal(existsSync(join(wsClean, '.agents')), false);

    // 12) Bare ID probe + agentapi send-message
    const ins = await req('GET', `/api/session/inspect?id=${workerId.slice(0, 8)}`);
    assert.equal(ins.status, 200);
    assert.equal(ins.data.status, 'ok');
    assert.equal(ins.data.info.goal, 'Sidecar探针目标');

    const msgRes = await req('POST', '/_sidecar/send-message', {
      conversationId: ctrlId,
      message: workerId,
    });
    assert.equal(msgRes.status, 200);
    assert.deepEqual(msgRes.data.forwarded, ['agentapi', 'send-message', ctrlId, workerId]);

    // 13) Flight diagnostics API + static ui-logic.mjs asset
    const uiLogicRes = await fetch(`${base}/ui-logic.mjs`);
    assert.equal(uiLogicRes.status, 200);
    assert.ok((await uiLogicRes.text()).includes('computeTabVisibility'));

    const diagUnauth = await fetch(`${base}/api/diagnostics`);
    assert.equal(diagUnauth.status, 401);

    const diag = await req('GET', '/api/diagnostics?limit=20');
    assert.equal(diag.status, 200);
    assert.equal(diag.data.ok, true);
    assert.ok(diag.data.events.some((ev) => ev.event === 'auth_rejected'));

    const diagClear = await req('POST', '/api/diagnostics/clear', {});
    assert.equal(diagClear.status, 200);
    assert.equal(diagClear.data.events.length, 0);

    // 14) Phase 2: Execution surfaces + Inbox + Zero-token sentinel sweep APIs
    const snapSurf = await req('GET', `/api/snapshot?workspace=${encodeURIComponent(ws)}`);
    assert.equal(snapSurf.status, 200);
    assert.ok(snapSurf.data.executionSurfaces);
    assert.ok(snapSurf.data.inbox);

    const sweepRes = await req('POST', '/api/sentinel/sweep', { workspace: ws });
    assert.equal(sweepRes.status, 200);
    assert.equal(sweepRes.data.ok, true);

    const inboxGet = await req('GET', `/api/inbox?workspace=${encodeURIComponent(ws)}`);
    assert.equal(inboxGet.status, 200);
    assert.equal(inboxGet.data.ok, true);

    const inboxAck = await req('POST', '/api/inbox/ack', { workspace: ws, ackAll: true });
    assert.equal(inboxAck.status, 200);

    // 15) Phase 3: Roadmap APIs (init, node upsert, cycle 400 guard, contract prompt, status unlock, delete)
    const rmInit = await req('POST', '/api/roadmap/init', { workspace: ws, storageMode: 'workspace', projectName: 'SidecarProj' });
    assert.equal(rmInit.status, 200);
    assert.equal(rmInit.data.snapshot.roadmap.exists, true);

    const rmN1 = await req('POST', '/api/roadmap/node/upsert', {
      workspace: ws,
      id: 'W1',
      title: '基础节点',
      status: 'active',
      isolation: 'share',
      collaboration: 'swarm_channel',
      ownership: 'src/a/',
      acceptance: 'npm test',
    });
    assert.equal(rmN1.status, 200);

    const rmN2 = await req('POST', '/api/roadmap/node/upsert', {
      workspace: ws,
      id: 'W2',
      title: '下游节点',
      status: 'planned',
      dependsOn: 'W1',
      isolation: 'share',
      collaboration: 'handoff_file',
      ownership: 'src/b/',
      acceptance: 'npm test',
    });
    assert.equal(rmN2.status, 200);

    const rmCycle = await req('POST', '/api/roadmap/node/upsert', {
      workspace: ws,
      id: 'W1',
      title: '循环测试',
      dependsOn: 'W2',
    });
    assert.equal(rmCycle.status, 400);

    const rmContract = await req('POST', '/api/roadmap/node/contract', { workspace: ws, id: 'W2' });
    assert.equal(rmContract.status, 200);
    assert.ok(rmContract.data.contractPrompt.includes('workspace: "share"'));

    const rmDone = await req('POST', '/api/roadmap/node/status', { workspace: ws, id: 'W1', status: 'done' });
    assert.equal(rmDone.status, 200);
    assert.equal(rmDone.data.newlyUnlocked.length, 1);
    assert.equal(rmDone.data.newlyUnlocked[0].id, 'W2');

    const rmDel = await req('POST', '/api/roadmap/node/delete', { workspace: ws, id: 'W2' });
    assert.equal(rmDel.status, 200);
    assert.equal(rmDel.data.snapshot.roadmap.graph.counts.total, 1);

    // 16) Phase 4 (v1.6.x): Modular view assets, DAG-gated hidden dispatch, malformed URL survival, exclusive lease mutex, metadata cache
    const badUrlRes = await fetch(`${base}//bad:port/api/snapshot`, {
      headers: { 'x-sidecar-token': token },
    });
    assert.ok(badUrlRes.status === 200 || badUrlRes.status === 400 || badUrlRes.status === 404);

    for (const viewPath of ['/views/overview.mjs', '/views/sessions.mjs', '/views/roadmap.mjs', '/views/settings.mjs']) {
      const vr = await fetch(`${base}${viewPath}`);
      assert.equal(vr.status, 200, `Expected 200 for ${viewPath}`);
    }

    // Done node W1 is rejected unless forced; blocked node W4 is rejected; ready node W3 succeeds
    const rmHiddenDone = await req('POST', '/api/roadmap/node/dispatch-hidden', { workspace: ws, id: 'W1' });
    assert.equal(rmHiddenDone.status, 409);

    await req('POST', '/api/roadmap/node/upsert', { workspace: ws, id: 'W3', title: '就绪分支', status: 'planned' });
    await req('POST', '/api/roadmap/node/upsert', { workspace: ws, id: 'W4', title: '阻塞分支', status: 'planned', dependsOn: 'W3' });

    const rmHiddenBlocked = await req('POST', '/api/roadmap/node/dispatch-hidden', { workspace: ws, id: 'W4' });
    assert.equal(rmHiddenBlocked.status, 409);

    const rmHiddenReady = await req('POST', '/api/roadmap/node/dispatch-hidden', { workspace: ws, id: 'W3' });
    assert.equal(rmHiddenReady.status, 200);
    assert.equal(rmHiddenReady.data.nodeId, 'W3');

    const meta1 = await req('POST', '/_sidecar/get-conversation-metadata', { conversationId: ctrlId });
    assert.equal(meta1.status, 200);
    const meta2 = await req('POST', '/_sidecar/get-conversation-metadata', { conversationId: ctrlId });
    assert.equal(meta2.status, 200);
    assert.equal(meta2.data._cached, true);

    const swarmClean = await req('POST', '/api/swarm/cleanup-request', { workspace: ws });
    assert.equal(swarmClean.status, 200);
    assert.equal(swarmClean.data.ok, true);

    // 17) Phase 5 (v1.7.0): SSE /api/events real-time push & Multi-workspace global overview
    const sseUnauth = await fetch(`${base}/api/events`);
    assert.equal(sseUnauth.status, 401);

    const sseAbort = new AbortController();
    let sseBuf = '';
    const sseRes = await fetch(`${base}/api/events?token=${token}&workspace=${encodeURIComponent(ws)}`, {
      signal: sseAbort.signal,
    });
    assert.equal(sseRes.status, 200);
    assert.ok((sseRes.headers.get('content-type') || '').includes('text/event-stream'));

    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    const readUntil = async (needle, timeoutMs = 2500) => {
      const deadline = Date.now() + timeoutMs;
      while (!sseBuf.includes(needle)) {
        const rem = Math.max(50, deadline - Date.now());
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for SSE frame "${needle}", got: ${sseBuf}`);
        }
        const chunk = await Promise.race([
          reader.read(),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`SSE read timeout (${rem}ms) for ${needle}`)), rem)),
        ]);
        if (chunk.done) break;
        sseBuf += decoder.decode(chunk.value, { stream: true });
      }
    };

    try {
      await readUntil('event: connected');
      sseBuf = '';
      const qSse = await req('POST', '/api/queue/upsert', {
        workspace: ws,
        id: 'T99',
        summary: 'SSE 实时推送验证',
        status: 'QUEUED',
        suggestedRoute: 'Gemini 4 Neon (High)',
      });
      assert.equal(qSse.status, 200);
      await readUntil('event: workspace_changed');
    } finally {
      sseAbort.abort();
      try {
        await reader.cancel();
      } catch {
        // ignore abort error
      }
    }

    const mwRes = await req('GET', `/api/workspaces/overview?workspace=${encodeURIComponent(ws)}`);
    assert.equal(mwRes.status, 200);
    assert.equal(mwRes.data.ok, true);
    const mw = mwRes.data.multiWorkspace;
    assert.ok(mw.workspaceCount >= 2);
    const mwPaths = mw.workspaces.map((it) => it.workspace);
    assert.ok(mwPaths.includes(ws));
    assert.ok(mwPaths.includes(wsClean));
    const currentItem = mw.workspaces.find((it) => it.workspace === ws);
    assert.equal(currentItem.isCurrent, true);
    assert.equal(currentItem.roadmapExists, true);

    // 18) v1.7.1: Global drawer hides switched-away plain non-registry workspaces & Sidecar relays deferred Stop receipts
    const wsPlain = join(sb.dir, 'ws_plain');
    mkdirSync(wsPlain, { recursive: true });
    await req('POST', '/api/workspace/select', { workspace: wsPlain });
    await req('POST', '/api/workspace/select', { workspace: ws });
    const mwFiltered = await req('GET', `/api/workspaces/overview?workspace=${encodeURIComponent(ws)}`);
    assert.equal(
      mwFiltered.data.multiWorkspace.workspaces.some((it) => it.workspace === wsPlain),
      false,
      'Non-registry plain workspace should be filtered out once switched away'
    );

    recordControllerFocus(dataDir, ws, { inFlight: false, lastUserInputAt: 0, lastTurnEndAt: 0 });
    setDeferredReceipt(dataDir, ws, {
      controllerId: ctrlId,
      message: '[CT_AUTO_RECEIPT] Sidecar代发测试回执',
      completedIds: [workerId],
    });
    assert.ok(loadWorkspaceInbox(dataDir, ws).deferredReceipt);
    const relaySweep = await req('POST', '/api/sentinel/sweep', { workspace: ws });
    assert.equal(relaySweep.status, 200);
    assert.equal(loadWorkspaceInbox(dataDir, ws).deferredReceipt, null, 'Sidecar sweep must relay and clear deferredReceipt');

    // 19) v1.8.1: Classic non-module bundle, no-store cache headers, cache-busting HTML stamps, and HEAD support
    const homeRes = await fetch(`${base}/`);
    assert.equal(homeRes.status, 200);
    assert.ok((homeRes.headers.get('cache-control') || '').includes('no-store'));
    const homeHtml = await homeRes.text();
    assert.ok(homeHtml.includes('/app.bundle.js?v='));
    assert.ok(homeHtml.includes('/boot-guard.js?v='));
    assert.ok(homeHtml.includes('/styles.css?v='));
    assert.equal(homeHtml.includes('type="module"'), false);

    const guardRes = await fetch(`${base}/boot-guard.js`);
    assert.equal(guardRes.status, 200);
    assert.ok((guardRes.headers.get('cache-control') || '').includes('no-store'));

    const bundleRes = await fetch(`${base}/app.bundle.js`);
    assert.equal(bundleRes.status, 200);
    assert.ok((bundleRes.headers.get('cache-control') || '').includes('no-store'));
    const bundleText = await bundleRes.text();
    new vm.Script(bundleText);
    assert.ok(bundleText.includes('__CT_BOOTED__'));
    assert.equal(/^[ \t]*(?:import|export)(?:\s+|\s*[{*])/m.test(bundleText), false);

    const headHome = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(headHome.status, 200);
    assert.equal(await headHome.text(), '');
    const headBundle = await fetch(`${base}/app.bundle.js`, { method: 'HEAD' });
    assert.equal(headBundle.status, 200);
    assert.equal(await headBundle.text(), '');

    // 20) Backend model guard enforcement on settings & controller updates
    assert.equal(
      (await req('POST', '/api/settings/global', { workspace: ws, l2StandardModel: 'Gemini 4 Argon (High)' })).status,
      400
    );
    assert.equal(
      (await req('POST', '/api/settings/global', { workspace: ws, l0ControllerModel: 'gemini-3.8-flash' })).status,
      400
    );
    assert.equal(
      (await req('POST', '/api/settings/workspace', { workspace: ws, overrides: { l2StandardModel: 'flash' } })).status,
      400
    );
    assert.equal(
      (
        await req('POST', '/api/controller/update', {
          workspace: ws,
          controllerId: ctrlId,
          defaultModel: 'Gemini 4 Argon',
        })
      ).status,
      400
    );
    const allowCustomGlobal = await req('POST', '/api/settings/global', {
      workspace: ws,
      modelGuardPolicy: 'custom_allowlist',
      customAllowedModels: ['custom-corp-v4'],
      l2StandardModel: 'custom-corp-v4',
    });
    assert.equal(allowCustomGlobal.status, 200);
    assert.equal(allowCustomGlobal.data.snapshot.settings.effective.l2StandardModel, 'custom-corp-v4');

    // 21) Snapshot stateSig short-circuit, ?unbound=1 empty-window guard, and 415 Content-Type CSRF defense
    const textPlainPost = await fetch(`${base}/api/queue/upsert`, {
      method: 'POST',
      headers: { 'x-sidecar-token': token, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ workspace: ws, id: 'CSRF1', summary: 'blocked' }),
    });
    assert.equal(textPlainPost.status, 415);

    const unboundSnap = await req('GET', '/api/snapshot?unbound=1');
    assert.equal(unboundSnap.status, 200);
    assert.ok(!unboundSnap.data.workspace);
    assert.ok(Array.isArray(unboundSnap.data.recentWorkspaces) && unboundSnap.data.recentWorkspaces.length >= 1);

    const fullSnap = await req('GET', `/api/snapshot?workspace=${encodeURIComponent(ws)}`);
    assert.equal(fullSnap.status, 200);
    assert.ok(typeof fullSnap.data.stateSig === 'string' && fullSnap.data.stateSig.length === 16);
    const shortRes = await fetch(
      `${base}/api/snapshot?workspace=${encodeURIComponent(ws)}&sinceSig=${encodeURIComponent(fullSnap.data.stateSig)}`,
      { headers: { 'x-sidecar-token': token } }
    );
    const shortRawText = await shortRes.text();
    const shortData = JSON.parse(shortRawText);
    assert.equal(shortRes.status, 200);
    assert.equal(shortData.unchanged, true);
    assert.equal(shortData.stateSig, fullSnap.data.stateSig);
    assert.ok(shortRawText.length < 240, `Expected tiny unchanged payload (<240B), got ${shortRawText.length}B`);
  } finally {
    if (server) await server.close();
    for (const k of Object.keys(process.env)) {
      if (!(k in prevEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v !== undefined) process.env[k] = v;
    }
    sb.cleanup();
  }
});
