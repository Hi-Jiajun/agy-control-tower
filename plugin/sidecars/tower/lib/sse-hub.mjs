import { existsSync, watch } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getWorkspaceSettingsDir, readJsonSafe } from '../../../lib/paths.mjs';

const HEARTBEAT_INTERVAL_MS = 20000;
const WATCH_DEBOUNCE_MS = 120;
const MAX_SSE_CLIENTS = 16;

function isTransientWatchFilename(filename) {
  if (!filename) return false;
  const s = String(filename);
  return s.startsWith('.tmp.') || s.startsWith('.tmp-') || s.endsWith('.lock');
}

/**
 * Zero-dependency Server-Sent Events (SSE) hub paired with debounced read-only fs.watch.
 * Never creates directories or files; closes watchers automatically when no clients are listening.
 */
export class SseHub {
  #clients = new Set();
  #watchers = new Map();
  #debounceTimer = null;
  #pendingWorkspace = '';
  #pendingReason = '';
  #watchedWorkspaces = new Set();
  #dataDir = '';
  #onFsEvent = null;

  constructor({ onFsEvent = null } = {}) {
    this.#onFsEvent = typeof onFsEvent === 'function' ? onFsEvent : null;
  }

  subscribe(req, res, { workspace = '', dataDir = '' } = {}) {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const heartbeatTimer = setInterval(() => {
      try {
        if (!res.writableEnded) {
          res.write(`: heartbeat ${Date.now()}\n\n`);
        }
      } catch {
        // client socket closed
      }
    }, HEARTBEAT_INTERVAL_MS);
    if (typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }

    if (this.#clients.size >= MAX_SSE_CLIENTS) {
      const oldest = this.#clients.values().next().value;
      if (oldest) {
        clearInterval(oldest.heartbeatTimer);
        this.#clients.delete(oldest);
        try {
          oldest.res.end();
        } catch {
          // ignore
        }
      }
    }
    const client = { req, res, workspace: workspace || '', heartbeatTimer };
    this.#clients.add(client);

    try {
      res.write(
        `event: connected\ndata: ${JSON.stringify({ ok: true, workspace: client.workspace, ts: Date.now() })}\n\n`
      );
    } catch {
      // ignore initial write failure
    }

    if (dataDir) this.#dataDir = dataDir;
    if (workspace) this.#touchWorkspace(workspace);
    this.#syncWatchers();

    const cleanup = () => {
      if (!this.#clients.has(client)) return;
      clearInterval(client.heartbeatTimer);
      this.#clients.delete(client);
      if (this.#clients.size === 0) {
        this.#closeAllWatchers();
      }
    };

    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('error', cleanup);
  }

  #touchWorkspace(wsReal) {
    if (!wsReal) return;
    this.#watchedWorkspaces.delete(wsReal);
    this.#watchedWorkspaces.add(wsReal);
  }

  trackWorkspace(wsReal, dataDir = '') {
    if (dataDir) this.#dataDir = dataDir;
    if (wsReal) this.#touchWorkspace(wsReal);
    if (this.#clients.size > 0) {
      this.#syncWatchers();
    }
  }

  notify({ workspace = '', reason = 'mutation' } = {}) {
    if (this.#clients.size === 0) return 0;
    const payload = JSON.stringify({
      workspace: workspace || '',
      reason: String(reason || 'mutation'),
      ts: Date.now(),
    });
    const frame = `event: workspace_changed\ndata: ${payload}\n\n`;
    let delivered = 0;
    for (const client of [...this.#clients]) {
      try {
        if (!client.res.writableEnded) {
          client.res.write(frame);
          delivered += 1;
        }
      } catch {
        clearInterval(client.heartbeatTimer);
        this.#clients.delete(client);
      }
    }
    return delivered;
  }

  #scheduleDebouncedNotify(workspace, reason) {
    if (workspace) this.#pendingWorkspace = workspace;
    this.#pendingReason = reason || 'fs_watch';
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      const ws = this.#pendingWorkspace;
      const rsn = this.#pendingReason;
      this.#pendingWorkspace = '';
      this.#pendingReason = '';
      this.#syncWatchers();
      this.notify({ workspace: ws, reason: rsn });
      if (this.#onFsEvent) {
        try {
          this.#onFsEvent({ workspace: ws, reason: rsn });
        } catch {
          // ignore callback failure
        }
      }
    }, WATCH_DEBOUNCE_MS);
    if (typeof this.#debounceTimer.unref === 'function') {
      this.#debounceTimer.unref();
    }
  }

  #ensureDirWatcher(dirPath, associatedWorkspace = '') {
    if (!dirPath) return;
    if (!existsSync(dirPath)) {
      const staleWatcher = this.#watchers.get(dirPath);
      if (staleWatcher) {
        try {
          staleWatcher.close();
        } catch {
          // ignore
        }
        this.#watchers.delete(dirPath);
      }
      return;
    }
    if (this.#watchers.has(dirPath)) return;
    try {
      const watcher = watch(dirPath, { persistent: false }, (_eventType, filename) => {
        if (!existsSync(dirPath)) {
          try {
            watcher.close();
          } catch {
            // ignore
          }
          this.#watchers.delete(dirPath);
        }
        if (isTransientWatchFilename(filename)) return;
        this.#scheduleDebouncedNotify(associatedWorkspace, `fs:${filename || 'change'}`);
      });
      watcher.on('error', () => {
        try {
          watcher.close();
        } catch {
          // ignore
        }
        this.#watchers.delete(dirPath);
      });
      if (typeof watcher.unref === 'function') {
        watcher.unref();
      }
      this.#watchers.set(dirPath, watcher);
    } catch {
      // fs.watch unsupported or ENOSPC; fallback polling remains active
    }
  }

  #syncWatchers() {
    if (this.#clients.size === 0) return;
    const desired = new Map();
    if (this.#dataDir && existsSync(this.#dataDir)) {
      desired.set(this.#dataDir, '');
      const wsRootDir = join(this.#dataDir, 'workspaces');
      if (existsSync(wsRootDir)) {
        desired.set(wsRootDir, '');
      }
    }
    for (const client of this.#clients) {
      if (client.workspace) this.#touchWorkspace(client.workspace);
    }
    for (const ws of [...this.#watchedWorkspaces].slice(-8)) {
      if (existsSync(ws)) {
        desired.set(ws, ws);
        const agentsDir = join(ws, '.agents');
        if (existsSync(agentsDir)) desired.set(agentsDir, ws);
        const researchDir = join(ws, 'research');
        if (existsSync(researchDir)) desired.set(researchDir, ws);
      }
      if (this.#dataDir) {
        const wsDataDir = getWorkspaceSettingsDir(this.#dataDir, ws);
        if (existsSync(wsDataDir)) {
          desired.set(wsDataDir, ws);
          const wsCfg = readJsonSafe(join(wsDataDir, 'settings.json'), null);
          if (wsCfg?.customRegistryRelPath && typeof wsCfg.customRegistryRelPath === 'string') {
            const customParent = dirname(resolve(ws, wsCfg.customRegistryRelPath));
            if (existsSync(customParent)) desired.set(customParent, ws);
          }
        }
      }
    }
    for (const [dirPath, watcher] of [...this.#watchers.entries()]) {
      if (!desired.has(dirPath) || !existsSync(dirPath)) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
        this.#watchers.delete(dirPath);
      }
    }
    for (const [dirPath, assocWs] of desired.entries()) {
      this.#ensureDirWatcher(dirPath, assocWs);
    }
  }

  #closeAllWatchers() {
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    for (const watcher of this.#watchers.values()) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    this.#watchers.clear();
  }

  get clientCount() {
    return this.#clients.size;
  }

  close() {
    this.#closeAllWatchers();
    for (const client of [...this.#clients]) {
      clearInterval(client.heartbeatTimer);
      try {
        client.res.end();
      } catch {
        // ignore
      }
      try {
        client.req.destroy?.();
      } catch {
        // ignore
      }
    }
    this.#clients.clear();
  }
}
