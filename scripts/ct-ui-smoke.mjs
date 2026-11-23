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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFlightEvent } from '../plugin/lib/logger.mjs';
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
  ];
  for (const p of fixed) {
    if (existsSync(p)) return p;
  }

  const pwCache = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(pwCache)) {
    try {
      const dirs = readdirSync(pwCache)
        .filter((d) => d.startsWith('chromium-'))
        .sort()
        .reverse();
      for (const d of dirs) {
        const cand = join(pwCache, d, 'chrome-linux64', 'chrome');
        if (existsSync(cand)) return cand;
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

async function waitForCondition(fn, { timeoutMs = 6000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
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

export async function runUiSmoke({ requireBrowser = false } = {}) {
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
  };

  let serverInstance = null;
  let chromeProc = null;
  let cdp = null;

  try {
    const ws = join(sb.dir, 'ws');
    const appData = join(sb.dir, 'app_data');
    const dataDir = join(sb.dir, 'plugin_data');
    const cfgDir = join(sb.dir, 'cfg');
    const profileDir = join(sb.dir, 'chrome-profile');
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
- **常驻模型配置**：\`Gemini 4 Neon (High)\`

## 三、活跃 / 挂起专职会话台账
| 会话链接与 ID | 任务编号 / 主题 | 模型与工具 | 资源锁状态 | 当前状态 | 工作目录与日志回查路径 |
| --- | --- | --- | --- | --- | --- |
| [\`${workerId.slice(0, 8)}\`](conversation://${workerId}) | UI 冒烟示例任务 | Gemini 4 Neon (High) | 纯离线无锁 | \`ACTIVE\` | - |

## 四、近期已归档里程碑会话索引
| 会话链接与 ID | 负责任务 / 里程碑 | 核心产出、验证锚点与文档位置 |
| --- | --- | --- |
| \`暂无\` | - | - |

## 五、待调度任务队列快照
| 编号 | 模块 / 问题简述 | 调度状态 | 建议路线与模型 |
| --- | --- | --- | --- |
| \`T1\` | 窄栏渲染验收 | \`QUEUED\` | L2 Gemini 4 Neon (High) |
`,
      'utf8'
    );

    writeFileSync(
      makeTranscriptPath(appData, ctrlId),
      `${JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high', status: 'DONE' })}\n`,
      'utf8'
    );
    writeFileSync(
      makeTranscriptPath(appData, workerId),
      `${JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high', status: 'DONE' })}\n`,
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

    const token = 'ct-smoke-token';
    serverInstance = new ControlTowerServer({ port: 0, token });
    const { port } = await serverInstance.start();

    const launched = await launchChrome(chromeBin, profileDir);
    chromeProc = launched.proc;
    cdp = await CdpClient.connect(launched.pageWsUrl);

    const consoleErrors = [];
    const pageExceptions = [];

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
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

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.sidecar = {
          conversationId: ${JSON.stringify(ctrlId)},
          getWorkspaceUris: async () => [${JSON.stringify(ws)}],
          onWorkspaceChange: (cb) => { setTimeout(() => cb([${JSON.stringify(ws)}]), 20); return () => {}; },
          ui: { toggleConversation: () => {} },
        };
      `,
    });

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/?token=${token}` });

    await waitForCondition(
      async () =>
        Boolean(
          await cdp.evaluate(
            `document.getElementById('ctrl-view')?.textContent?.includes(${JSON.stringify(ctrlId.slice(0, 8))})`
          )
        ),
      { label: 'Control Tower snapshot render' }
    );

    const versionBadge = await cdp.evaluate(`document.getElementById('version-badge')?.textContent?.trim()`);
    assert.equal(versionBadge, `v${pluginMeta.version}`);

    const checks = [];

    // 1) Check all 6 tabs in narrow 390px dark theme (zero overflow)
    for (const tab of ['overview', 'sessions', 'roadmap', 'queue', 'raw', 'settings']) {
      await cdp.evaluate(`document.querySelector('.tab[data-tab="${tab}"]')?.click()`);
      await new Promise((r) => setTimeout(r, 80));
      const metrics = await cdp.evaluate(`({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        panelVisible: !document.getElementById('tab-${tab}')?.classList.contains('hidden'),
      })`);
      assert.equal(metrics.panelVisible, true, `Tab ${tab} should be visible`);
      assert.ok(
        metrics.scrollWidth <= metrics.innerWidth + 2,
        `Narrow 390px overflow on tab ${tab}: scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth}`
      );
      checks.push(`narrow-dark:${tab}`);
    }

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

    // 1c) Native inline archive form (zero window.prompt) in sessions tab
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
      async () => (await cdp.evaluate(`document.getElementById('archived-count-badge')?.textContent?.trim()`)) === '1',
      { label: 'inline archive completed' }
    );
    checks.push('inline-archive-form');

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

    // 3) Check all 3 settings scopes in narrow width
    for (const scope of ['plugin', 'global', 'workspace']) {
      await cdp.evaluate(`document.querySelector('.seg-btn[data-scope="${scope}"]')?.click()`);
      await new Promise((r) => setTimeout(r, 60));
      const metrics = await cdp.evaluate(`({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        visible: !document.getElementById('settings-scope-${scope}')?.classList.contains('hidden'),
      })`);
      assert.equal(metrics.visible, true, `Settings scope ${scope} should be visible`);
      assert.ok(
        metrics.scrollWidth <= metrics.innerWidth + 2,
        `Narrow 390px overflow on settings scope ${scope}: ${metrics.scrollWidth} > ${metrics.innerWidth}`
      );
      checks.push(`narrow-settings:${scope}`);
    }

    // 4) Switch to Light theme and verify theme sync
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });
    await cdp.evaluate(`document.documentElement.setAttribute('style', '--background: #ffffff')`);
    await new Promise((r) => setTimeout(r, 60));
    const lightTheme = await cdp.evaluate(`document.documentElement.dataset.theme`);
    assert.equal(lightTheme, 'light', 'Theme observer should switch dataset.theme to light');
    checks.push('narrow-light-theme');

    // 5) Resize to wide 960x844 and check overview & sessions
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 960,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.evaluate(`document.querySelector('.tab[data-tab="sessions"]')?.click()`);
    await new Promise((r) => setTimeout(r, 80));
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
  try {
    const res = await runUiSmoke({ requireBrowser });
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
