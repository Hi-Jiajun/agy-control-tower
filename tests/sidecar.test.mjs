import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
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

    // 1) Static assets accessible without token
    assert.equal((await req('GET', '/', undefined, false)).status, 200);
    assert.equal((await req('GET', '/styles.css', undefined, false)).status, 200);
    assert.equal((await req('GET', '/app.js', undefined, false)).status, 200);
    assert.equal((await req('GET', '/preload.js', undefined, false)).status, 200);

    // 2) Both GET and POST /api/* + /_sidecar/* require valid token -> 401 without token
    assert.equal((await req('GET', `/api/snapshot?workspace=${encodeURIComponent(ws)}`, undefined, false)).status, 401);
    assert.equal((await req('GET', `/api/settings?workspace=${encodeURIComponent(ws)}`, undefined, false)).status, 401);
    assert.equal((await req('GET', `/api/session/inspect?id=${workerId.slice(0, 8)}`, undefined, false)).status, 401);
    assert.equal((await req('POST', '/api/registry/init', { workspace: ws }, false)).status, 401);
    assert.equal((await req('POST', '/_sidecar/send-message', { conversationId: ctrlId, message: 'hi' }, false)).status, 401);

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
  } finally {
    if (server) await server.close();
    process.env = prevEnv;
    sb.cleanup();
  }
});
