#!/usr/bin/env node
/**
 * Control Tower Ring 4 (L3): Zero-Dependency Real Headless Browser UI Smoke Test (CDP)
 * Launches an isolated sandbox ControlTowerServer + local headless Chromium/Chrome,
 * connects over Node built-in WebSocket (CDP), and verifies Aux Pane narrow width
 * (390x844 dark & light) + wide width (960x844), zero console/page errors, zero
 * horizontal overflow, tab switching, and diagnostics flight-log UI interactivity.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFlightEvent } from '../plugin/lib/logger.mjs';
import { upsertInboxItem } from '../plugin/lib/inbox.mjs';
import { ControlTowerServer } from '../plugin/sidecars/tower/main.mjs';
import { makeConvId, makeSandbox, makeTranscriptPath } from '../tests/helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

function findChromeBinary() {
  const envBin = (process.env.CT_CHROME_BIN || process.env.CHROME_BIN || '').trim();
  if (envBin && existsSync(envBin)) return envBin;

  const fixed = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  if (process.platform === 'win32') {
    const winRoots = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    for (const root of winRoots) {
      fixed.push(
        join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(root, 'Chromium', 'Application', 'chrome.exe'),
        join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      );
    }
  }
  for (const p of fixed) {
    if (p && existsSync(p)) return p;
  }

  const pwCaches = [
    join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright') : '',
  ].filter(Boolean);

  const pwRelCandidates = [
    ['chrome-linux64', 'chrome'],
    ['chrome-linux', 'chrome'],
    ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ['chrome-win64', 'chrome.exe'],
    ['chrome-win', 'chrome.exe'],
  ];

  for (const pwCache of pwCaches) {
    if (!existsSync(pwCache)) continue;
    try {
      const dirs = readdirSync(pwCache)
        .filter((d) => d.startsWith('chromium-'))
        .sort()
        .reverse();
      for (const d of dirs) {
        for (const relParts of pwRelCandidates) {
          const cand = join(pwCache, d, ...relParts);
          if (existsSync(cand)) return cand;
        }
      }
    } catch {
      // ignore
    }
  }
  return '';
}

class CdpClient {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (evt) => {
      const msg = JSON.parse(String(evt.data));
      if (msg.id && this.#pending.has(msg.id)) {
        const { resolve: res, reject: rej } = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error) {
          rej(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
        } else {
          res(msg.result || {});
        }
        return;
      }
      if (msg.method && this.#listeners.has(msg.method)) {
        for (const fn of this.#listeners.get(msg.method)) {
          fn(msg.params || {});
        }
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('Timed out connecting to CDP WebSocket')), 8000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        res();
      });
      ws.addEventListener('error', (err) => {
        clearTimeout(timer);
        rej(err);
      });
    });
    return new CdpClient(ws);
  }

  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, []);
    this.#listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rej(new Error(`CDP timeout waiting for ${method}`));
      }, 10000);
      this.#pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          res(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          rej(err);
        },
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Eval exception: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      // ignore
    }
  }
}

async function waitForCondition(fn, { timeoutMs = 6000, intervalMs = 100, label = 'condition', getDebugInfo = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const extra = typeof getDebugInfo === 'function' ? ` | debug=${await getDebugInfo()}` : '';
  throw new Error(`Timed out waiting for ${label}${extra}`);
}

async function launchChrome(chromeBin, profileDir) {
  const proc = spawn(
    chromeBin,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  try {
    let stderrBuf = '';
    const wsBrowserUrl = await new Promise((res, rej) => {
      const timer = setTimeout(
        () => rej(new Error(`Chrome failed to emit DevTools URL: ${stderrBuf.slice(-400)}`)),
        12000
      );
      proc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString('utf8');
        const m = stderrBuf.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
        if (m) {
          clearTimeout(timer);
          res(m[1]);
        }
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        rej(new Error(`Chrome exited early (${code}): ${stderrBuf.slice(-400)}`));
      });
    });

    const portMatch = wsBrowserUrl.match(/127\.0\.0\.1:(\d+)/);
    const debugPort = portMatch[1];
    const targetsRes = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const targets = await targetsRes.json();
    const pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || targets[0];
    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error('Could not find CDP page target');
    }
    return { proc, pageWsUrl: pageTarget.webSocketDebuggerUrl };
  } catch (err) {
    try {
      proc.kill('SIGKILL');
    } catch {
      // ignore
    }
    throw err;
  }
}

export async function runUiSmoke({ requireBrowser = false, screenshotDir = '' } = {}) {
  if (typeof WebSocket !== 'function') {
    if (requireBrowser) {
      throw new Error('L3 UI smoke requires Node.js >= 22 (built-in global WebSocket)');
    }
    return { skipped: true, reason: 'Global WebSocket unavailable on current Node runtime' };
  }
  const chromeBin = findChromeBinary();
  if (!chromeBin) {
    if (requireBrowser) {
      throw new Error('No Chromium/Chrome binary found for L3 UI smoke test');
    }
    return { skipped: true, reason: 'No local Chrome/Chromium binary available' };
  }

  const pluginMeta = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin', 'plugin.json'), 'utf8'));
  const sb = makeSandbox('ct-ui-smoke-');
  const prevEnv = {
    ANTIGRAVITY_APP_DATA_DIR: process.env.ANTIGRAVITY_APP_DATA_DIR,
    AGY_CONTROL_TOWER_DATA_DIR: process.env.AGY_CONTROL_TOWER_DATA_DIR,
    AGY_CONFIG_DIR: process.env.AGY_CONFIG_DIR,
    ANTIGRAVITY_AGENTAPI_EXE: process.env.ANTIGRAVITY_AGENTAPI_EXE,
  };

  let serverInstance = null;
  let chromeProc = null;
  let cdp = null;

  try {
    const wsClean = join(sb.dir, 'projects', 'alpha-app');
    const ws = join(sb.dir, 'projects', 'control-tower');
    const appData = join(sb.dir, 'app_data');
    const dataDir = join(sb.dir, 'plugin_data');
    const cfgDir = join(sb.dir, 'cfg');
    const profileDir = join(sb.dir, 'chrome-profile');
    mkdirSync(wsClean, { recursive: true });
    mkdirSync(join(ws, '.agents', 'handoffs'), { recursive: true });
    mkdirSync(appData, { recursive: true });
    mkdirSync(cfgDir, { recursive: true });
    mkdirSync(profileDir, { recursive: true });

    writeFileSync(
      join(ws, '.agents', 'handoffs', 'W1.md'),
      '# 接力契约：W1\n- 对外接口: parsePacket()\n- 验收命令: npm test\n',
      'utf8'
    );

    const ctrlId = makeConvId('c', '1', '4', '8', 'a');
    const workerId = makeConvId('a', '2', '4', '8', 'b');
    const swarmImplId = makeConvId('b', '3', '4', '8', 'c');
    const swarmVerifyId = makeConvId('d', '4', '4', '8', 'e');
    const dispatchedConvId = makeConvId('e', '5', '4', '8', 'f');
    const manualConvId = makeConvId('f', '6', '4', '8', '1');

    const mockAgentApi = join(sb.dir, 'mock-agentapi.mjs');
    const mockCallsFile = join(sb.dir, 'agentapi-calls.jsonl');
    writeFileSync(
      mockAgentApi,
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(mockCallsFile)}, JSON.stringify(args) + '\\n', 'utf8');
if (args.includes('get-conversation-metadata')) {
  process.stdout.write(JSON.stringify({ response: { conversationMetadata: { metadata: { projectId: 'proj-smoke-1' } } } }));
} else if (args.includes('new-conversation')) {
  process.stdout.write(JSON.stringify({ ok: true, conversationId: ${JSON.stringify(dispatchedConvId)}, forwarded: args }));
} else {
  process.stdout.write(JSON.stringify({ ok: true, forwarded: args }));
}
`,
      'utf8'
    );
    chmodSync(mockAgentApi, 0o755);

    writeFileSync(
      join(ws, '.agents', 'SESSION-REGISTRY.md'),
      `# 跨会话调度总账

## 一、当前独占资源租约
| 字段 | 当前值 |
| --- | --- |
| **锁状态** | \`IDLE（空闲待分配）\` |
| **持锁会话** | - |
| **独占对象与任务** | 测试沙箱 |
| **租约起始时间** | - |
| **允许操作范围与保护现场** | - |
| **交还解锁判据** | 清理临时环境 |

## 二、常驻主交流总控会话
- **当前现役总控会话**：\`${ctrlId}\`（状态：\`ONLINE\`）
- **常驻模型配置**：\`Gemini 4 Neon (XHigh)\`

## 三、活跃 / 挂起专职会话台账
| 会话链接与 ID | 任务编号 / 主题 | 模型与工具 | 资源锁状态 | 当前状态 | 工作目录与日志回查路径 |
| --- | --- | --- | --- | --- | --- |
| [\`${workerId.slice(0, 8)}\`](conversation://${workerId}) | UI 冒烟示例任务 | Orchestrator (Neon Extra High) | 纯离线无锁 | \`ACTIVE\` | - |

## 四、近期已归档里程碑会话索引
| 会话链接与 ID | 负责任务 / 里程碑 | 核心产出、验证锚点与文档位置 |
| --- | --- | --- |
| \`暂无\` | - | - |

## 五、待调度任务队列快照
| 编号 | 模块 / 问题简述 | 调度状态 | 建议路线与模型 |
| --- | --- | --- | --- |
| \`T1\` | 窄栏渲染验收 | \`QUEUED\` | L2 Orchestrator (Neon Extra High) |
`,
      'utf8'
    );

    writeFileSync(
      makeTranscriptPath(appData, ctrlId),
      `${JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-xhigh', status: 'DONE' })}\n`,
      'utf8'
    );
    writeFileSync(
      makeTranscriptPath(appData, workerId),
      `${JSON.stringify({ step_index: 4, type: 'PLANNER_RESPONSE', model: 'orchestrator-neon-xhigh', status: 'DONE', goal: '窄栏信息架构验收' })}\n`,
      'utf8'
    );
    writeFileSync(
      makeTranscriptPath(appData, swarmImplId),
      `${JSON.stringify({ step_index: 6, type: 'PLANNER_RESPONSE', model: 'orchestrator-neon-xhigh', status: 'RUNNING' })}\n`,
      'utf8'
    );
    writeFileSync(
      makeTranscriptPath(appData, swarmVerifyId),
      `${JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high', status: 'DONE' })}\n`,
      'utf8'
    );

    // Seed an active Native Swarm under controller's brain directory
    const swarmDir = join(appData, 'brain', ctrlId, '.system_generated', 'swarm');
    mkdirSync(swarmDir, { recursive: true });
    writeFileSync(
      join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Control Tower UI Polish Swarm',
        members: {
          'impl-ui': {
            role: 'worker',
            conversation_id: swarmImplId,
            model: 'Orchestrator (Neon Extra High)',
            workspace: 'share',
          },
          verifier: {
            role: 'worker',
            conversation_id: swarmVerifyId,
            model: 'Gemini 4 Neon (High)',
            workspace: 'inherit',
          },
        },
      }),
      'utf8'
    );
    writeFileSync(
      join(swarmDir, 'board.jsonl'),
      `${JSON.stringify({ seq: 1, agent: 'coordinator', text: '@impl-ui 完成双行紧凑顶栏与折叠渐进披露', time: '04:30' })}\n` +
        `${JSON.stringify({ seq: 2, agent: 'impl-ui', text: '已完成 360px/390px 几何零溢出对齐，提交验收', time: '04:35' })}\n`,
      'utf8'
    );

    appendFlightEvent(dataDir, {
      level: 'info',
      source: 'hook',
      event: 'version_sync_notified',
      conv: ctrlId,
      message: 'Smoke test info event',
    });
    appendFlightEvent(dataDir, {
      level: 'warn',
      source: 'hook',
      event: 'write_guard_triggered',
      ok: false,
      conv: workerId,
      message: 'Smoke test write guard warn event',
    });

    process.env.ANTIGRAVITY_APP_DATA_DIR = appData;
    process.env.AGY_CONTROL_TOWER_DATA_DIR = dataDir;
    process.env.AGY_CONFIG_DIR = cfgDir;
    process.env.ANTIGRAVITY_AGENTAPI_EXE = mockAgentApi;

    const token = 'ct-smoke-token';
    serverInstance = new ControlTowerServer({ port: 0, token });
    const { port } = await serverInstance.start();

    const launched = await launchChrome(chromeBin, profileDir);
    chromeProc = launched.proc;
    cdp = await CdpClient.connect(launched.pageWsUrl);

    const consoleErrors = [];
    const pageExceptions = [];
    const requestedUrls = [];

    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');
    cdp.on('Network.requestWillBeSent', (p) => {
      const reqUrl = p?.request?.url;
      if (reqUrl) requestedUrls.push(reqUrl);
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });

    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        consoleErrors.push(text);
      }
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      pageExceptions.push(p.exceptionDetails?.text || JSON.stringify(p.exceptionDetails));
    });

    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true });
    }
    const saveShot = async (name) => {
      if (!screenshotDir) return;
      await new Promise((r) => setTimeout(r, 140));
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(screenshotDir, name), Buffer.from(shot.data, 'base64'));
    };

    const trustedClick = async (selector) => {
      const pt = await cdp.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      assert.ok(pt, `trustedClick target not found: ${selector}`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: pt.x,
        y: pt.y,
        button: 'left',
        clickCount: 1,
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: pt.x,
        y: pt.y,
        button: 'left',
        clickCount: 1,
      });
    };

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (() => {
          const listeners = [];
          window.__ctWsUris = [];
          window.__ctEmitWsChange = (uris) => {
            window.__ctWsUris = Array.isArray(uris) ? uris : [];
            listeners.forEach((cb) => cb(window.__ctWsUris));
          };
          const mockSidecar = {
            conversationId: ${JSON.stringify(ctrlId)},
            getWorkspaceUris: async () => window.__ctWsUris,
            onWorkspaceChange: (cb) => {
              listeners.push(cb);
              return () => {};
            },
            ui: { toggleConversation: () => {} },
          };
          Object.defineProperty(window, 'sidecar', {
            get: () => mockSidecar,
            set: () => {},
            configurable: true,
          });
        })();
      `,
    });

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/?token=${token}` });

    // Phase A: Unbound workspace guidance (zero blank screen) + compact 2-row geometry
    await waitForCondition(
      async () =>
        Boolean(
          await cdp.evaluate(`(() => {
            const skel = document.getElementById('boot-skeleton');
            const unb = document.getElementById('unbound-state');
            return skel?.classList.contains('hidden') && unb && !unb.classList.contains('hidden');
          })()`)
        ),
      {
        label: 'Unbound workspace state render',
        getDebugInfo: async () =>
          JSON.stringify({
            consoleErrors,
            pageExceptions,
            toast: await cdp.evaluate(`document.getElementById('toast')?.textContent || ''`),
          }),
      }
    );

    const versionBadge = await cdp.evaluate(`document.getElementById('version-badge')?.textContent?.trim()`);
    assert.equal(versionBadge, `v${pluginMeta.version}`);

    const checks = [];

    // 0) Verify zero <datalist> and all 13 grouped <select class="model-select"> pickers work natively
    const pickerBootMeta = await cdp.evaluate(`(() => {
      const datalists = document.querySelectorAll('datalist').length;
      const listInputs = document.querySelectorAll('[list]').length;
      const selects = [...document.querySelectorAll('select.model-select')];
      const allPopulated = selects.every((s) => s.options.length >= 7 && s.querySelectorAll('optgroup').length >= 2);
      return { datalists, listInputs, selectCount: selects.length, allPopulated };
    })()`);
    assert.equal(pickerBootMeta.datalists, 0, 'Zero broken <datalist> elements may remain');
    assert.equal(pickerBootMeta.listInputs, 0, 'Zero [list] attributes may remain');
    assert.equal(pickerBootMeta.selectCount, 13, 'All 13 model fields must use native grouped <select>');
    assert.equal(pickerBootMeta.allPopulated, true, 'Every model <select> must populate full optgroups on boot');
    checks.push('all-13-grouped-model-selects');

    // 0) Verify classic non-module boot guard, preload inline style immunity, and compact 2-row topbar geometry
    const bootMeta = await cdp.evaluate(`({
      booted: window.__CT_BOOTED__ === true,
      fallbackHidden: document.getElementById('boot-fallback')?.classList.contains('hidden') === true,
      moduleScriptCount: document.querySelectorAll('script[type="module"]').length,
      darkTheme: document.documentElement.dataset.theme,
      darkBodyBg: getComputedStyle(document.body).backgroundColor,
      topbarHeight: Math.round(document.querySelector('.topbar')?.getBoundingClientRect().height || 0),
      tabRows390: new Set([...document.querySelectorAll('.tab')].map((b) => b.offsetTop)).size,
    })`);
    assert.equal(bootMeta.booted, true, 'window.__CT_BOOTED__ should be true');
    assert.equal(bootMeta.fallbackHidden, true, '#boot-fallback banner should stay hidden');
    assert.equal(bootMeta.moduleScriptCount, 0, 'Zero <script type="module"> elements should exist');
    assert.equal(bootMeta.darkTheme, 'dark', 'Initial dark color-scheme should set dataset.theme=dark');
    assert.equal(bootMeta.darkBodyBg, 'rgb(22, 23, 25)', 'Dark body background must not be overridden by preload inline white');
    assert.ok(bootMeta.topbarHeight > 0 && bootMeta.topbarHeight <= 92, `Topbar should stay compact (<=92px), got ${bootMeta.topbarHeight}px`);
    assert.equal(bootMeta.tabRows390, 1, 'All 6 tabs must sit on a single horizontal row at 390px');
    const esmRequests = requestedUrls.filter((u) => {
      try {
        const p = new URL(u).pathname;
        return p.endsWith('.mjs') || p.startsWith('/views/');
      } catch {
        return false;
      }
    });
    assert.deepEqual(esmRequests, [], `Unexpected .mjs or /views/ network requests: ${esmRequests.join(', ')}`);
    assert.ok(
      requestedUrls.some((u) => u.includes('/app.bundle.js')),
      'Expected browser to fetch classic /app.bundle.js'
    );
    assert.ok(
      requestedUrls.some((u) => u.includes('/boot-guard.js')),
      'Expected browser to fetch classic /boot-guard.js'
    );
    checks.push('classic-bundle-boot');
    checks.push('unbound-state-and-compact-topbar');

    // Verify ultra-narrow 360px Aux Pane geometry (single-row tabs + zero horizontal overflow)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 360,
      height: 844,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await new Promise((r) => setTimeout(r, 60));
    const ultraNarrowMeta = await cdp.evaluate(`({
      tabRows360: new Set([...document.querySelectorAll('.tab')].map((b) => b.offsetTop)).size,
      noOverflow360: document.documentElement.scrollWidth <= window.innerWidth + 2,
    })`);
    assert.equal(ultraNarrowMeta.tabRows360, 1, 'All 6 2-char tabs must remain on 1 row at 360px');
    assert.equal(ultraNarrowMeta.noOverflow360, true, 'Zero horizontal overflow at 360px width');
    checks.push('ultra-narrow-360-geometry');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await saveShot('01-unbound-dark.png');

    // Phase B: Uninitialized workspace onboarding + mode-card switch + live registry init
    await cdp.evaluate(`window.__ctEmitWsChange([${JSON.stringify(wsClean)}])`);
    await waitForCondition(
      async () =>
        Boolean(
          await cdp.evaluate(`(() => {
            const emp = document.getElementById('empty-state');
            const unb = document.getElementById('unbound-state');
            return emp && !emp.classList.contains('hidden') && unb?.classList.contains('hidden');
          })()`)
        ),
      { label: 'Empty uninitialized workspace onboarding render' }
    );
    const onboardingMeta = await cdp.evaluate(`(() => {
      const selOpt = document.getElementById('ws-select')?.selectedOptions?.[0]?.textContent || '';
      const needsInit = [...document.querySelectorAll('.tab.needs-init')].map((b) => b.dataset.tab);
      document.querySelector('.mode-card[data-relpath="@plugin_data/SESSION-REGISTRY.md"]')?.click();
      const managedVal = document.getElementById('init-relpath')?.value || '';
      document.querySelector('.mode-card[data-relpath=".agents/SESSION-REGISTRY.md"]')?.click();
      const stdVal = document.getElementById('init-relpath')?.value || '';
      document.querySelector('.tab[data-tab="sessions"]')?.click();
      const hintShown = !document.getElementById('empty-tab-hint')?.classList.contains('hidden');
      document.querySelector('.tab[data-tab="overview"]')?.click();
      return { selOpt, needsInit, managedVal, stdVal, hintShown };
    })()`);
    assert.equal(onboardingMeta.selOpt, 'alpha-app  (projects)', 'Workspace select should format short label');
    assert.deepEqual(onboardingMeta.needsInit, ['sessions', 'queue', 'raw'], 'Uninitialized tabs should carry .needs-init');
    assert.equal(onboardingMeta.managedVal, '@plugin_data/SESSION-REGISTRY.md', 'Managed mode card should sync select');
    assert.equal(onboardingMeta.stdVal, '.agents/SESSION-REGISTRY.md', 'Standard mode card should sync select');
    assert.equal(onboardingMeta.hintShown, true, 'Clicking uninitialized tab should display contextual unlock hint');
    await saveShot('02-empty-onboarding-dark.png');

    await cdp.evaluate(`document.getElementById('init-registry-btn')?.click()`);
    await waitForCondition(
      async () =>
        Boolean(
          await cdp.evaluate(`!document.getElementById('tab-overview')?.classList.contains('hidden') && document.querySelectorAll('.tab.needs-init').length === 0`)
        ),
      { label: 'Live registry init from onboarding card' }
    );
    const freshInitHygiene = await cdp.evaluate(`({
      leaseText: document.getElementById('lease-status-pill')?.textContent || '',
      queuePill: document.getElementById('tab-count-queue')?.textContent?.trim() || '',
    })`);
    assert.equal(freshInitHygiene.leaseText.includes('\`'), false, 'Fresh init lease pill must have zero stray backticks');
    assert.equal(freshInitHygiene.queuePill, '', 'Fresh init must not treat skeleton <T1> as a real queued task');
    checks.push('empty-onboarding-mode-cards-and-init');

    // Phase C: Switch to populated workspace (ws)
    await cdp.evaluate(`window.__ctEmitWsChange([${JSON.stringify(ws)}])`);
    await waitForCondition(
      async () =>
        Boolean(
          await cdp.evaluate(
            `document.getElementById('ctrl-view')?.textContent?.includes(${JSON.stringify(ctrlId.slice(0, 8))})`
          )
        ),
      { label: 'Populated Control Tower snapshot render' }
    );

    // 0a) Verify SSE real-time stream connects and Overview quiet restraint holds when IDLE & unread===0
    await waitForCondition(
      async () => (await cdp.evaluate(`document.getElementById('poll-toggle-btn')?.textContent?.trim()`)) === 'SSE 实时',
      { label: 'SSE live stream connected' }
    );
    const overviewRestraint = await cdp.evaluate(`(() => {
      const ctrlTop = document.getElementById('ctrl-card')?.getBoundingClientRect().top || 0;
      const leaseTop = document.getElementById('lease-card')?.getBoundingClientRect().top || 0;
      return {
        ctrlBeforeLease: ctrlTop < leaseTop,
        releaseBtnHidden: document.getElementById('release-lease-btn')?.classList.contains('hidden') === true,
        idleSummaryVisible: document.getElementById('lease-idle-summary')?.classList.contains('hidden') === false,
        leaseGridHidden: document.getElementById('lease-view')?.classList.contains('hidden') === true,
        deliverDisabled: document.getElementById('inbox-deliver-all-btn')?.disabled === true,
        ackAllHidden: document.getElementById('inbox-ack-all-btn')?.classList.contains('hidden') === true,
      };
    })()`);
    assert.equal(overviewRestraint.ctrlBeforeLease, true, 'Controller card should appear above Lease card');
    assert.equal(overviewRestraint.releaseBtnHidden, true, 'Release button should hide when lease is already IDLE');
    assert.equal(overviewRestraint.idleSummaryVisible, true, 'Idle 1-line summary should show when lease is IDLE');
    assert.equal(overviewRestraint.leaseGridHidden, true, '6-row placeholder kv-grid should hide when lease is IDLE');
    assert.equal(overviewRestraint.deliverDisabled, true, 'Deliver-all button should disable when unread === 0');
    assert.equal(overviewRestraint.ackAllHidden, true, 'Ack-all button should hide when unread === 0');
    await saveShot('03-overview-idle-dark.png');
    checks.push('sse-realtime-connected');
    checks.push('overview-idle-restraint');

    // 0a-2) Exercise Overview interactive controls via real coordinate clicks: controller model select save, lease hold -> release, /learn RPC, cross-origin copy fallback, sentinel sweep
    await cdp.evaluate(`(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async () => { throw new Error('Cross-origin iframe clipboard denied'); } },
        configurable: true,
      });
    })()`);
    await trustedClick('#copy-ctrl-id-btn');
    await waitForCondition(
      async () => Boolean(await cdp.evaluate(`document.getElementById('toast')?.textContent?.includes('已复制总控 ID')`)),
      { label: 'cross-origin execCommand copy fallback on controller ID' }
    );
    await trustedClick('#ctrl-learn-btn');
    await waitForCondition(
      async () => Boolean(await cdp.evaluate(`document.getElementById('toast')?.textContent?.includes('已向现役总控发送 /learn')`)),
      { label: 'controller /learn RPC button' }
    );
    await cdp.evaluate(`(() => {
      document.getElementById('edit-ctrl-btn')?.click();
      const sel = document.getElementById('cf-defaultModel');
      sel.value = 'Orchestrator (Neon Extra High)';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('cf-appendHistory').checked = true;
      document.getElementById('cf-summary').value = 'UI 冒烟模型切换校验';
      document.getElementById('ctrl-form')?.requestSubmit();
    })()`);
    await waitForCondition(
      async () => Boolean(await cdp.evaluate(`document.getElementById('ctrl-view')?.textContent?.includes('Orchestrator (Neon Extra High)')`)),
      { label: 'controller model select update' }
    );
    // Restore controller default model to Gemini 4 Neon (XHigh)
    await cdp.evaluate(`(() => {
      document.getElementById('edit-ctrl-btn')?.click();
      const sel = document.getElementById('cf-defaultModel');
      sel.value = 'Gemini 4 Neon (XHigh)';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('ctrl-form')?.requestSubmit();
    })()`);
    await waitForCondition(
      async () => Boolean(await cdp.evaluate(`document.getElementById('ctrl-view')?.textContent?.includes('Gemini 4 Neon (XHigh)')`)),
      { label: 'controller model select restore' }
    );

    // Lease hold -> full grid + release button shown -> 1-click release back to IDLE restraint
    await cdp.evaluate(`(() => {
      document.getElementById('edit-lease-btn')?.click();
      document.getElementById('lf-lockStatus').value = 'LOCKED (独占测试中)';
      document.getElementById('lf-holder').value = ${JSON.stringify(workerId)};
      document.getElementById('lease-form')?.requestSubmit();
    })()`);
    await waitForCondition(
      async () =>
        Boolean(
          await cdp.evaluate(
            `!document.getElementById('release-lease-btn')?.classList.contains('hidden') && !document.getElementById('lease-view')?.classList.contains('hidden')`
          )
        ),
      { label: 'held lease reveals full kv-grid and release button' }
    );
    await cdp.evaluate(`document.getElementById('release-lease-btn')?.click()`);
    await waitForCondition(
      async () =>
        Boolean(
          await cdp.evaluate(
            `document.getElementById('release-lease-btn')?.classList.contains('hidden') && !document.getElementById('lease-idle-summary')?.classList.contains('hidden')`
          )
        ),
      { label: '1-click lease release restores IDLE summary' }
    );
    await cdp.evaluate(`document.getElementById('sentinel-sweep-btn')?.click()`);
    await waitForCondition(
      async () => Boolean(await cdp.evaluate(`document.getElementById('toast')?.textContent?.includes('哨兵巡检完成')`)),
      { label: 'manual sentinel sweep button' }
    );
    checks.push('overview-ctrl-model-lease-copy-learn-sweep');

    // 0b) Verify cross-workspace global overview drawer & 1-click /learn trigger exist cleanly in 390px
    const hasLearnControls = await cdp.evaluate(`Boolean(document.getElementById('ctrl-learn-btn')) && Boolean(document.querySelector('.send-learn-btn')) && Boolean(document.getElementById('gs-autoLearnMode'))`);
    assert.equal(hasLearnControls, true, 'v1.8.0 /learn buttons and autoLearnMode selector should render');
    checks.push('v180-learn-controls');

    await cdp.evaluate(`document.getElementById('global-ws-btn')?.click()`);
    await waitForCondition(
      async () =>
        Boolean(
          await cdp.evaluate(`(() => {
            const dr = document.getElementById('global-ws-drawer');
            const list = document.getElementById('global-ws-list');
            return dr && !dr.classList.contains('hidden') && (list?.textContent || '').includes(${JSON.stringify(ctrlId.slice(0, 8))});
          })()`)
        ),
      { label: 'global workspaces drawer opened' }
    );
    const drawerOverflow = await cdp.evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 2`);
    assert.equal(drawerOverflow, true, 'Narrow 390px overflow with global workspaces drawer open');
    await cdp.evaluate(`document.getElementById('close-global-ws-btn')?.click()`);
    assert.equal(
      await cdp.evaluate(`document.getElementById('global-ws-drawer')?.classList.contains('hidden')`),
      true,
      'Global workspaces drawer should close'
    );
    checks.push('global-workspaces-drawer');

    // 1) Check all 6 tabs in narrow 390px dark theme (zero overflow + sliding #tab-ink-bar tracking)
    const inkPositions = new Set();
    for (const tab of ['overview', 'sessions', 'roadmap', 'queue', 'raw', 'settings']) {
      await cdp.evaluate(`document.querySelector('.tab[data-tab="${tab}"]')?.click()`);
      await new Promise((r) => setTimeout(r, 80));
      const metrics = await cdp.evaluate(`({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        panelVisible: !document.getElementById('tab-${tab}')?.classList.contains('hidden'),
        inkTransform: document.getElementById('tab-ink-bar')?.style.transform || '',
        inkWidth: parseFloat(document.getElementById('tab-ink-bar')?.style.width || '0'),
      })`);
      assert.equal(metrics.panelVisible, true, `Tab ${tab} should be visible`);
      assert.ok(metrics.inkWidth > 16, `Sliding #tab-ink-bar width should track active tab ${tab}`);
      inkPositions.add(metrics.inkTransform);
      assert.ok(
        metrics.scrollWidth <= metrics.innerWidth + 2,
        `Narrow 390px overflow on tab ${tab}: scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth}`
      );
      checks.push(`narrow-dark:${tab}`);
    }
    assert.equal(inkPositions.size, 6, 'Sliding #tab-ink-bar must move to 6 distinct x-positions across 6 tabs');
    checks.push('sliding-tab-ink-bar');

    // 1a) Verify live Native Swarm card + inline bare-ID search bar in sessions tab
    await cdp.evaluate(`document.querySelector('.tab[data-tab="sessions"]')?.click()`);
    await new Promise((r) => setTimeout(r, 80));
    const swarmMeta = await cdp.evaluate(`({
      swarmVisible: !document.getElementById('swarm-card')?.classList.contains('hidden'),
      swarmText: document.getElementById('swarm-card')?.textContent || '',
      sessionsCountPill: document.getElementById('tab-count-sessions')?.textContent?.trim() || '',
    })`);
    assert.equal(swarmMeta.swarmVisible, true, 'Active native Swarm card should be visible');
    assert.ok(swarmMeta.swarmText.includes('impl-ui'), 'Swarm member impl-ui should render');
    assert.equal(swarmMeta.sessionsCountPill, '3', 'Tab count should reflect 2 swarm + 1 top-level session');
    await saveShot('04-sessions-swarm-dark.png');

    await cdp.evaluate(`(() => {
      const inp = document.getElementById('probe-id-input');
      inp.value = ${JSON.stringify(workerId.slice(0, 8))};
      document.getElementById('probe-btn').click();
    })()`);
    await waitForCondition(
      async () =>
        Boolean(
          await cdp.evaluate(
            `document.getElementById('probe-result')?.textContent?.includes(${JSON.stringify(workerId)})`
          )
        ),
      { label: 'inline bare-ID probe result' }
    );
    checks.push('sessions-swarm-and-inline-probe');

    // 1b) Interactive Roadmap init, node creation, handoff preview, cycle error guard, and fill-dispatch bridge
    await cdp.evaluate(`document.querySelector('.tab[data-tab="roadmap"]')?.click()`);
    await new Promise((r) => setTimeout(r, 60));
    await cdp.evaluate(`document.getElementById('rm-init-ws-btn')?.click()`);
    await waitForCondition(
      async () => Boolean(await cdp.evaluate(`!document.getElementById('rm-body')?.classList.contains('hidden')`)),
      { label: 'roadmap interactive init' }
    );
    await cdp.evaluate(`(() => {
      document.getElementById('rm-toggle-node-form-btn').click();
      document.getElementById('rnf-id').value = 'W1';
      document.getElementById('rnf-title').value = '协议层核心';
      document.getElementById('rnf-ownership').value = 'src/proto/';
      document.getElementById('rnf-acceptance').value = 'npm test';
      document.getElementById('rm-node-form').requestSubmit();
    })()`);
    await waitForCondition(
      async () => Boolean(await cdp.evaluate(`document.querySelectorAll('#rm-nodes-list .handoff-details').length === 1`)),
      { label: 'roadmap node W1 with handoff details rendered' }
    );
    await cdp.evaluate(`(() => {
      document.getElementById('rm-toggle-node-form-btn').click();
      document.getElementById('rnf-id').value = 'W2';
      document.getElementById('rnf-title').value = '下游消费';
      document.getElementById('rnf-dependsOn').value = 'W1';
      document.getElementById('rm-node-form').requestSubmit();
    })()`);
    await waitForCondition(
      async () => Boolean(await cdp.evaluate(`document.getElementById('rm-nodes-list')?.textContent?.includes('W2')`)),
      { label: 'roadmap node W2 rendered' }
    );
    const rmStatusMeta = await cdp.evaluate(`({
      readyCount: document.querySelectorAll('#rm-nodes-list .item-box[data-node-status="ready"]').length,
      blockedCount: document.querySelectorAll('#rm-nodes-list .item-box[data-node-status="blocked"]').length,
      roadmapPill: document.getElementById('tab-count-roadmap')?.textContent?.trim() || '',
    })`);
    assert.equal(rmStatusMeta.readyCount, 1, 'W1 should carry data-node-status=ready');
    assert.equal(rmStatusMeta.blockedCount, 1, 'W2 should carry data-node-status=blocked');
    assert.equal(rmStatusMeta.roadmapPill, '0/2', 'Roadmap tab count should show 0/2');
    await saveShot('05-roadmap-dag-dark.png');

    // Attempt cyclic dependency W1 -> W2 and verify error toast without uncaught exception
    await cdp.evaluate(`(() => {
      document.querySelector('.rm-edit-node-btn[data-id="W1"]').click();
      document.getElementById('rnf-dependsOn').value = 'W2';
      document.getElementById('rm-node-form').requestSubmit();
    })()`);
    await waitForCondition(
      async () => Boolean(await cdp.evaluate(`document.getElementById('toast')?.textContent?.includes('循环依赖')`)),
      { label: 'roadmap cycle error toast' }
    );
    await cdp.evaluate(`document.getElementById('rm-node-cancel-btn')?.click()`);
    const rmOverflow = await cdp.evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 2`);
    assert.equal(rmOverflow, true, 'Narrow 390px overflow after roadmap interactive flow');
    checks.push('roadmap-interactive-crud-handoff-cycle');

    // Click fill-dispatch on W1 -> jumps to sessions tab with workstreamId=W1 prefilled
    await cdp.evaluate(`document.querySelector('.rm-fill-dispatch-btn[data-id="W1"]')?.click()`);
    await waitForCondition(
      async () => (await cdp.evaluate(`document.getElementById('df-workstreamId')?.value`)) === 'W1',
      { label: 'roadmap fill-dispatch prefill' }
    );
    checks.push('roadmap-fill-dispatch');

    // 1c) Swarm cleanup RPC, manual session custom model, direct dispatch RPC, and inline archive
    await cdp.evaluate(`(() => {
      const sel = document.getElementById('df-model');
      sel.value = 'Orchestrator (Carbon)';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('df-slash').value = '/plan';
      document.getElementById('df-topic').value = 'W1 直派全链路测试';
      document.getElementById('df-prompt').value = '验证直派模型选择与入账';
      document.getElementById('dispatch-form')?.requestSubmit();
    })()`);
    await waitForCondition(
      async () =>
        Boolean(
          await cdp.evaluate(
            `document.getElementById('active-sessions-list')?.textContent?.includes(${JSON.stringify(dispatchedConvId.slice(0, 8))})`
          )
        ),
      { label: 'direct dispatch via df-model select and mock agentapi' }
    );
    await cdp.evaluate(`document.getElementById('toggle-dispatch-btn')?.click()`);

    await cdp.evaluate(`document.getElementById('swarm-cleanup-btn')?.click()`);
    await waitForCondition(
      async () => Boolean(await cdp.evaluate(`document.getElementById('toast')?.textContent?.includes('回收 1 个休眠成员')`)),
      { label: 'swarm waiting cleanup request RPC' }
    );

    // Test manual session form with __custom__ model input reveal
    await cdp.evaluate(`(() => {
      document.getElementById('toggle-session-form-btn')?.click();
      document.getElementById('sf-id').value = ${JSON.stringify(manualConvId)};
      document.getElementById('sf-topic').value = '手动登记自定义模型验证';
      const sel = document.getElementById('sf-modelTool');
      sel.value = '__custom__';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const cust = document.getElementById('sf-modelTool-custom');
      cust.value = 'Orchestrator (Neon Extra High) + /plan';
      document.getElementById('session-form')?.requestSubmit();
    })()`);
    await waitForCondition(
      async () =>
        Boolean(
          await cdp.evaluate(
            `document.getElementById('active-sessions-list')?.textContent?.includes('手动登记自定义模型验证')`
          )
        ),
      { label: 'manual session enrollment with __custom__ modelTool' }
    );
    checks.push('sessions-dispatch-swarm-and-custom-model');

    await cdp.evaluate(`document.querySelector('.archive-conv-btn')?.click()`);
    await waitForCondition(
      async () => Boolean(await cdp.evaluate(`!document.getElementById('archive-form')?.classList.contains('hidden')`)),
      { label: 'inline archive form opened' }
    );
    await cdp.evaluate(`(() => {
      document.getElementById('af-summary').value = 'L3 冒烟归档验证通过';
      document.getElementById('archive-form').requestSubmit();
    })()`);
    await waitForCondition(
      async () =>
        Boolean(
          await cdp.evaluate(
            `document.getElementById('archived-count-badge')?.textContent?.trim() === '1' && document.getElementById('archived-fold')?.open === true`
          )
        ),
      { label: 'inline archive completed and fold opened' }
    );
    checks.push('inline-archive-form');

    // Roadmap hidden dispatch + mark done unlock propagation
    await cdp.evaluate(`document.querySelector('.tab[data-tab="roadmap"]')?.click()`);
    await new Promise((r) => setTimeout(r, 60));
    await cdp.evaluate(`document.querySelector('.rm-dispatch-hidden-btn[data-id="W1"]')?.click()`);
    await waitForCondition(
      async () =>
        Boolean(
          await cdp.evaluate(
            `document.getElementById('toast')?.textContent?.includes('契约投递总控按隐藏面派单') && document.querySelectorAll('#rm-nodes-list .item-box[data-node-status="active"]').length === 1`
          )
        ),
      { label: 'roadmap hidden dispatch marks W1 active' }
    );
    await cdp.evaluate(`document.querySelector('.rm-mark-done-btn[data-id="W1"]')?.click()`);
    await waitForCondition(
      async () =>
        Boolean(
          await cdp.evaluate(
            `document.querySelectorAll('#rm-nodes-list .item-box[data-node-status="ready"]').length === 1 && document.getElementById('tab-count-roadmap')?.textContent?.trim() === '1/2'`
          )
        ),
      { label: 'marking W1 done unlocks W2 to ready and updates tab count to 1/2' }
    );
    checks.push('roadmap-hidden-dispatch-and-unlock');

    // 1d) Collapsible queue form + route select create/edit + 2-step delete + raw templates/save
    await cdp.evaluate(`document.querySelector('.tab[data-tab="queue"]')?.click()`);
    await waitForCondition(
      async () => (await cdp.evaluate(`document.getElementById('queue-count-badge')?.textContent?.trim()`)) === '1',
      { label: 'queue tab shows initial T1 item' }
    );
    const queueProgressive = await cdp.evaluate(`(() => {
      const initiallyHidden = document.getElementById('queue-form')?.classList.contains('hidden') === true;
      document.getElementById('toggle-queue-form-btn')?.click();
      const opened = document.getElementById('queue-form')?.classList.contains('hidden') === false;
      document.getElementById('qf-id').value = 'T2';
      document.getElementById('qf-summary').value = '队列模型路线下拉保存验证';
      const rSel = document.getElementById('qf-route');
      rSel.value = 'L3 Orchestrator (Carbon)';
      rSel.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('queue-form')?.requestSubmit();
      return { initiallyHidden, opened };
    })()`);
    assert.deepEqual(queueProgressive, { initiallyHidden: true, opened: true });
    await waitForCondition(
      async () => (await cdp.evaluate(`document.getElementById('queue-count-badge')?.textContent?.trim()`)) === '2',
      { label: 'queue upsert T2 with selected L3 route' }
    );
    const qEditSelected = await cdp.evaluate(`(() => {
      document.querySelector('.q-edit-btn[data-id="T2"]')?.click();
      const v = document.getElementById('qf-route')?.value || '';
      document.getElementById('qf-reset-btn')?.click();
      return v;
    })()`);
    assert.equal(qEditSelected, 'L3 Orchestrator (Carbon)', 'Editing T2 must select L3 Orchestrator (Carbon) in qf-route');

    await cdp.evaluate(`document.querySelector('.tab[data-tab="raw"]')?.click()`);
    await saveShot('06-queue-and-raw-dark.png');
    await trustedClick('.copy-tpl[data-tpl="bootstrapPrompt"]');
    await waitForCondition(
      async () => Boolean(await cdp.evaluate(`document.getElementById('toast')?.textContent?.includes('已复制模板')`)),
      { label: 'raw tab copy bootstrap template' }
    );
    await cdp.evaluate(`document.getElementById('save-raw-btn')?.click()`);
    await waitForCondition(
      async () => Boolean(await cdp.evaluate(`document.getElementById('toast')?.textContent?.includes('台账已保存')`)),
      { label: 'raw markdown editor save' }
    );
    checks.push('queue-route-select-and-raw-save');

    await cdp.evaluate(`document.querySelector('.tab[data-tab="queue"]')?.click()`);
    await cdp.evaluate(`document.querySelector('.q-del-btn[data-id="T1"]')?.click()`);
    const armedState = await cdp.evaluate(`(() => {
      const btn = document.querySelector('.q-del-btn[data-id="T1"]');
      return {
        text: btn?.textContent?.trim() || '',
        armed: Boolean(btn?.classList.contains('btn-confirm-armed')),
        count: document.getElementById('queue-count-badge')?.textContent?.trim() || '',
      };
    })()`);
    assert.equal(armedState.text, '确认删除?', 'First click should arm inline confirm label');
    assert.equal(armedState.armed, true, 'First click should add btn-confirm-armed class');
    assert.equal(armedState.count, '2', 'First click must not immediately delete queue item');
    await cdp.evaluate(`document.querySelector('.q-del-btn[data-id="T1"]')?.click()`);
    await waitForCondition(
      async () => (await cdp.evaluate(`document.getElementById('queue-count-badge')?.textContent?.trim()`)) === '1',
      { label: 'second click confirms queue deletion' }
    );
    checks.push('inline-2step-confirm');

    // Return to settings tab for diagnostics + plugin settings form save check
    await cdp.evaluate(`document.querySelector('.tab[data-tab="settings"]')?.click()`);
    await new Promise((r) => setTimeout(r, 80));
    await cdp.evaluate(`document.getElementById('plugin-settings-form')?.requestSubmit()`);
    await waitForCondition(
      async () => Boolean(await cdp.evaluate(`document.getElementById('toast')?.textContent?.includes('已保存插件设置')`)),
      { label: 'plugin settings form submit' }
    );
    checks.push('plugin-settings-submit');

    // 2) Verify diagnostics card renders real flight events & filtering works
    await waitForCondition(
      async () => Number(await cdp.evaluate(`document.querySelectorAll('#diag-events-list .diag-row').length`)) >= 2,
      { label: 'diagnostics rows rendered' }
    );
    const totalDiagRows = Number(
      await cdp.evaluate(`document.querySelectorAll('#diag-events-list .diag-row').length`)
    );
    await cdp.evaluate(`(() => {
      const sel = document.getElementById('diag-level-filter');
      sel.value = 'warn_or_error';
      sel.dispatchEvent(new Event('change'));
    })()`);
    await waitForCondition(
      async () =>
        Boolean(
          await cdp.evaluate(`(() => {
            const rows = document.querySelectorAll('#diag-events-list .diag-row');
            const txt = document.getElementById('diag-events-list')?.textContent || '';
            return rows.length >= 1 && rows.length < ${totalDiagRows} && !txt.includes('Smoke test info event') && txt.includes('Smoke test write guard warn event');
          })()`)
        ),
      { label: 'diagnostics warn_or_error filter' }
    );
    checks.push('diagnostics-filter');

    // 3) Check all 3 settings scopes in narrow width + sliding segmented pill index
    for (const [idx, scope] of ['plugin', 'global', 'workspace'].entries()) {
      await cdp.evaluate(`document.querySelector('.seg-btn[data-scope="${scope}"]')?.click()`);
      await new Promise((r) => setTimeout(r, 60));
      const metrics = await cdp.evaluate(`({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        visible: !document.getElementById('settings-scope-${scope}')?.classList.contains('hidden'),
        segIdx: document.querySelector('.segmented')?.dataset.activeIdx || '',
      })`);
      assert.equal(metrics.visible, true, `Settings scope ${scope} should be visible`);
      assert.equal(metrics.segIdx, String(idx), `Segmented pill data-active-idx should equal ${idx} for ${scope}`);
      assert.ok(
        metrics.scrollWidth <= metrics.innerWidth + 2,
        `Narrow 390px overflow on settings scope ${scope}: ${metrics.scrollWidth} > ${metrics.innerWidth}`
      );
      checks.push(`narrow-settings:${scope}`);
    }

    // 3b) Deep Settings interactive test: Global model guard + custom allowlist sync + Workspace model override & clear while dirty
    await cdp.evaluate(`document.querySelector('.seg-btn[data-scope="global"]')?.click()`);
    await cdp.evaluate(`(() => {
      const sel = document.getElementById('gs-l2StandardModel');
      sel.value = '__custom__';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('gs-l2StandardModel-custom').value = 'Gemini 4 Argon';
      document.getElementById('global-settings-form')?.requestSubmit();
    })()`);
    await waitForCondition(
      async () => Boolean(await cdp.evaluate(`document.getElementById('toast')?.textContent?.includes('禁用 Argon')`)),
      { label: 'global settings blocks forbidden Argon model with toast' }
    );
    await cdp.evaluate(`(() => {
      document.querySelector('#settings-scope-global details.adv-fold').open = true;
      document.getElementById('gs-modelGuardPolicy').value = 'custom_allowlist';
      document.getElementById('gs-customAllowedModels').value = 'custom-corp-v4';
      document.getElementById('gs-l2StandardModel-custom').value = 'custom-corp-v4';
      document.getElementById('gs-l0ControllerModel').value = 'Gemini 4 Neon (XHigh)';
      document.getElementById('global-settings-form')?.requestSubmit();
    })()`);
    await waitForCondition(
      async () => Boolean(await cdp.evaluate(`document.getElementById('toast')?.textContent?.includes('已保存全局设置')`)),
      { label: 'global settings saves allowlisted custom-corp-v4' }
    );
    const customPropagated = await cdp.evaluate(`(() => {
      const dfHas = [...document.getElementById('df-model').options].some((o) => o.value === 'custom-corp-v4');
      const wsHas = [...document.getElementById('ws-ov-l2StandardModel').options].some((o) => o.value === 'custom-corp-v4');
      return dfHas && wsHas;
    })()`);
    assert.equal(customPropagated, true, 'Saved customAllowedModels must sync dynamically into all model <select> pickers');
    await saveShot('09-settings-global-models-dark.png');

    // Workspace override select + clear-override while form is dirty
    await cdp.evaluate(`document.querySelector('.seg-btn[data-scope="workspace"]')?.click()`);
    await cdp.evaluate(`(() => {
      document.querySelector('#settings-scope-workspace details.adv-fold').open = true;
      const sel = document.getElementById('ws-ov-l2StandardModel');
      sel.value = 'Orchestrator (Carbon)';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('ws-settings-form')?.requestSubmit();
    })()`);
    await waitForCondition(
      async () =>
        Boolean(
          await cdp.evaluate(
            `document.getElementById('ov-tag-l2StandardModel')?.textContent?.trim() === '工作区覆盖'`
          )
        ),
      { label: 'workspace model override saved' }
    );
    // Make workspace form dirty on another field, then click 继承 (.ws-clear-ov) on l2StandardModel
    await cdp.evaluate(`(() => {
      const th = document.getElementById('ws-ov-controllerCompactionThreshold');
      th.value = '6';
      th.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.ws-clear-ov[data-key="l2StandardModel"]')?.click();
    })()`);
    await waitForCondition(
      async () =>
        Boolean(
          await cdp.evaluate(
            `document.getElementById('ws-ov-l2StandardModel')?.value === '' && document.getElementById('ov-tag-l2StandardModel')?.textContent?.trim() === '继承全局'`
          )
        ),
      { label: 'ws-clear-ov resets select & badge even when workspace form is dirty' }
    );
    await saveShot('10-settings-ws-models-dark.png');
    checks.push('settings-global-guard-allowlist-and-ws-override-clear');

    // 4) Capture folded Settings dark shot, then seed active unread P1 inbox item + test deliver + Light theme
    await cdp.evaluate(`document.querySelector('.seg-btn[data-scope="plugin"]')?.click()`);
    await saveShot('07-settings-folded-dark.png');

    upsertInboxItem(dataDir, ws, {
      dedupKey: 'smoke-p1-done',
      priority: 'P1',
      kind: 'worker_done',
      source: 'hook',
      convId: swarmImplId,
      title: '[CT_REPORT:DONE] W1 协议层核心已通过单测',
      summary: '全量 28 项协议断言通过，等待总控解锁下游 W2。',
    });
    await cdp.evaluate(`(() => {
      document.querySelector('.tab[data-tab="overview"]')?.click();
      document.getElementById('refresh-btn')?.click();
    })()`);
    await waitForCondition(
      async () =>
        Boolean(
          await cdp.evaluate(
            `document.getElementById('tab-count-overview')?.textContent?.trim() === '1' && document.getElementById('inbox-deliver-all-btn')?.disabled === false && !document.getElementById('inbox-ack-all-btn')?.classList.contains('hidden')`
          )
        ),
      { label: 'Unread P1 inbox activates overview count & deliver/ack actions' }
    );
    checks.push('overview-active-inbox-unlock');

    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });
    await cdp.evaluate(
      `document.documentElement.setAttribute('style', '--background: #f7f7f8; --card: #ffffff; --foreground: #1d1f21; --primary: #007acc')`
    );
    await new Promise((r) => setTimeout(r, 60));
    const lightMeta = await cdp.evaluate(`({
      theme: document.documentElement.dataset.theme,
      bodyFont: getComputedStyle(document.body).fontFamily,
      bodyBg: getComputedStyle(document.body).backgroundColor,
    })`);
    assert.equal(lightMeta.theme, 'light', 'Theme observer should switch dataset.theme to light');
    assert.ok(lightMeta.bodyFont.includes('Google Sans'), 'Body font stack should prefer Google Sans Flex');
    assert.equal(lightMeta.bodyBg, 'rgb(247, 247, 248)', 'Body background should bind to host --background token');
    checks.push('narrow-light-theme-and-tokens');

    await saveShot('08-overview-light.png');

    // Verify Inbox Deliver RPC clears unread count cleanly
    await cdp.evaluate(`document.getElementById('inbox-deliver-all-btn')?.click()`);
    await waitForCondition(
      async () =>
        Boolean(
          await cdp.evaluate(
            `document.getElementById('tab-count-overview')?.textContent?.trim() === '' && document.getElementById('inbox-deliver-all-btn')?.disabled === true`
          )
        ),
      { label: 'inbox deliver-all sends to controller and resets unread badge' }
    );
    checks.push('inbox-deliver-rpc');

    // Verify setHtmlIfChanged preserves live DOM nodes across unchanged manual refresh
    await cdp.evaluate(`(() => {
      document.querySelector('.tab[data-tab="overview"]')?.click();
      const firstKv = document.querySelector('#ctrl-view .kv-k');
      if (firstKv) firstKv.__ctKeepAlive = 42;
      document.getElementById('refresh-btn')?.click();
    })()`);
    await new Promise((r) => setTimeout(r, 120));
    const domPreserved = await cdp.evaluate(`document.querySelector('#ctrl-view .kv-k')?.__ctKeepAlive === 42`);
    assert.equal(domPreserved, true, 'setHtmlIfChanged must skip innerHTML teardown when snapshot HTML is unchanged');
    checks.push('zero-thrash-dom-memoization');

    // 5) Resize to wide 960x844 and check overview & sessions
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 960,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.evaluate(`document.querySelector('.tab[data-tab="sessions"]')?.click()`);
    await new Promise((r) => setTimeout(r, 200));
    const wideOverflow = await cdp.evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 2`);
    assert.equal(wideOverflow, true, 'Wide viewport should have zero horizontal overflow');
    checks.push('wide-960:sessions');

    assert.deepEqual(consoleErrors, [], `Console errors detected: ${consoleErrors.join(' | ')}`);
    assert.deepEqual(pageExceptions, [], `Uncaught page exceptions: ${pageExceptions.join(' | ')}`);

    return {
      skipped: false,
      ok: true,
      browser: chromeBin.split('/').pop(),
      versionBadge,
      checksPassed: checks.length,
      checks,
      consoleErrors: 0,
      pageExceptions: 0,
    };
  } finally {
    if (cdp) cdp.close();
    if (chromeProc) {
      const waitExit = new Promise((res) => {
        if (chromeProc.exitCode !== null) return res();
        const t = setTimeout(res, 500);
        chromeProc.once('exit', () => {
          clearTimeout(t);
          res();
        });
      });
      try {
        chromeProc.kill('SIGKILL');
      } catch {
        // ignore
      }
      await waitExit;
    }
    if (serverInstance) {
      await serverInstance.close();
    }
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    sb.cleanup();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const jsonMode = process.argv.includes('--json');
  const requireBrowser = process.argv.includes('--require-browser');
  const shotArg = process.argv.find((a) => a.startsWith('--screenshot-dir='));
  const screenshotDir = shotArg ? resolve(shotArg.slice('--screenshot-dir='.length)) : '';
  try {
    const res = await runUiSmoke({ requireBrowser, screenshotDir });
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else if (res.skipped) {
      console.log(`SKIP: ${res.reason}`);
    } else {
      console.log(
        `OK: L3 真浏览器 UI 冒烟全部通过 (${res.browser}, ${res.versionBadge}, ${res.checksPassed} 项窄栏/亮暗主题/诊断交互检查, 0 Console Error)`
      );
    }
  } catch (err) {
    console.error(`FAIL: L3 UI 冒烟失败 -> ${err?.message || err}`);
    process.exit(1);
  }
}
