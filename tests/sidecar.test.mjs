import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ControlTowerServer } from '../plugin/sidecars/tower/main.mjs';
import { makeConvId, makeSandbox, makeTranscriptPath } from './helpers.mjs';

test('Sidecar enforces full token auth, zero-write GET, full Section 1..5 CRUD, and agentapi bridge', async () => {
  const sb = makeSandbox();
  const prevEnv = { ...process.env };
  let server;
  try {
    const ws = join(sb.dir, 'ws');
    const appDir = join(sb.dir, 'app');
    const dataDir = join(sb.dir, 'plugin_data');
    mkdirSync(ws, { recursive: true });
    mkdirSync(join(appDir, 'brain'), { recursive: true });

    const ctrlId = makeConvId('c', '1', '4', '8', 'a');
    const workerId = makeConvId('a', '9', '4', '8', 'f');
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

    // Mock agentapi executable
    const mockExe = join(sb.dir, 'mock-agentapi.mjs');
    const mockLog = join(sb.dir, 'agentapi-calls.json');
    writeFileSync(
      mockExe,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(mockLog)}, JSON.stringify(process.argv.slice(2)), 'utf8');
process.stdout.write(JSON.stringify({ ok: true, forwarded: process.argv.slice(2) }));
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
    assert.equal((await req('GET', `/api/session/inspect?id=${workerId.slice(0, 8)}`, undefined, false)).status, 401);
    assert.equal((await req('POST', '/api/registry/init', { workspace: ws }, false)).status, 401);
    assert.equal((await req('POST', '/_sidecar/send-message', { conversationId: ctrlId, message: 'hi' }, false)).status, 401);

    // 3) GET /api/snapshot is strictly read-only (does not create recent-workspaces.json)
    const snapBefore = await req('GET', `/api/snapshot?workspace=${encodeURIComponent(ws)}`);
    assert.equal(snapBefore.status, 200);
    assert.equal(snapBefore.data.registryExists, false);
    assert.equal(existsSync(join(dataDir, 'recent-workspaces.json')), false);

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

    // 6) Section 2 Controller update + history
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

    // 9) Section 5 Queue upsert/delete + raw save + traversal 403
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

    // 10) Bare ID probe + agentapi send-message + blocked new-conversation
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

    const newConvBlocked = await req('POST', '/_sidecar/new-conversation', { message: 'hello' });
    assert.equal(newConvBlocked.status, 403);
  } finally {
    if (server) await server.close();
    process.env = prevEnv;
    sb.cleanup();
  }
});
