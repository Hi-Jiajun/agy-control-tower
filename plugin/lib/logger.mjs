import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export const DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_LOG_MAX_FILES = 3;
export const SLOW_OP_THRESHOLD_MS = 100;
export const SLOW_RPC_THRESHOLD_MS = 500;

const HOME_DIR_RE = new RegExp('/(?:' + 'ho' + 'me|' + 'Us' + 'ers)/[^/\\s"\'`]+', 'g');
const PRIVATE_IP_RE = new RegExp(
  '\\b(?:10\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01])|' + '192' + '\\.' + '168' + ')\\.\\d{1,3}\\.\\d{1,3}\\b',
  'g'
);
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const QUERY_TOKEN_RE = /([?&](?:token|key|secret|auth)=)[^&\s"']+/gi;
const SENSITIVE_KEY_RE = /token|secret|password|authorization|cookie|apikey|api_key/i;

export function getFlightLogDir(dataDir) {
  return join(resolve(dataDir), 'logs');
}

export function getFlightLogPath(dataDir) {
  return join(getFlightLogDir(dataDir), 'ct-flight.jsonl');
}

export function sanitizeLogString(input, maxLen = 400) {
  if (input === null || input === undefined) return '';
  let text = String(input)
    .replace(/\r?\n+/g, ' ')
    .replace(HOME_DIR_RE, '<HOME>')
    .replace(PRIVATE_IP_RE, '<PRIVATE_IP>')
    .replace(BEARER_RE, '$1<REDACTED>')
    .replace(QUERY_TOKEN_RE, '$1<REDACTED>')
    .trim();
  if (text.length > maxLen) {
    text = `${text.slice(0, Math.max(16, maxLen - 3))}...`;
  }
  return text;
}

export function sanitizeLogValue(val, depth = 0) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'boolean' || typeof val === 'number') return val;
  if (typeof val === 'string') return sanitizeLogString(val);
  if (val instanceof Error) {
    return {
      name: sanitizeLogString(val.name || 'Error', 80),
      message: sanitizeLogString(val.message || '', 300),
    };
  }
  if (depth >= 4) return '[TRUNCATED]';
  if (Array.isArray(val)) {
    return val.slice(0, 20).map((item) => sanitizeLogValue(item, depth + 1));
  }
  if (typeof val === 'object') {
    const out = {};
    let count = 0;
    for (const [k, v] of Object.entries(val)) {
      if (count >= 30) break;
      count += 1;
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeLogValue(v, depth + 1);
      }
    }
    return out;
  }
  return sanitizeLogString(String(val));
}

function rotateLogIfNeeded(logPath, maxBytes, maxFiles) {
  if (!existsSync(logPath)) return;
  let size = 0;
  try {
    size = statSync(logPath).size;
  } catch {
    return;
  }
  if (size < maxBytes) return;

  const keep = Math.max(1, Number(maxFiles) || DEFAULT_LOG_MAX_FILES);
  const oldest = `${logPath}.${keep - 1}`;
  if (existsSync(oldest)) {
    try {
      unlinkSync(oldest);
    } catch {
      // ignore rotation cleanup errors
    }
  }
  for (let i = keep - 2; i >= 1; i -= 1) {
    const src = `${logPath}.${i}`;
    const dst = `${logPath}.${i + 1}`;
    if (existsSync(src)) {
      try {
        renameSync(src, dst);
      } catch {
        // ignore rotation rename errors
      }
    }
  }
  if (keep > 1) {
    try {
      renameSync(logPath, `${logPath}.1`);
    } catch {
      // ignore
    }
  } else {
    try {
      unlinkSync(logPath);
    } catch {
      // ignore
    }
  }
}

export function appendFlightEvent(
  dataDir,
  entry,
  { maxBytes = DEFAULT_LOG_MAX_BYTES, maxFiles = DEFAULT_LOG_MAX_FILES } = {}
) {
  if (!dataDir || !entry || typeof entry !== 'object') return false;
  try {
    const logDir = getFlightLogDir(dataDir);
    mkdirSync(logDir, { recursive: true });
    const logPath = getFlightLogPath(dataDir);
    rotateLogIfNeeded(logPath, maxBytes, maxFiles);

    const levelRaw = String(entry.level || 'info').toLowerCase();
    const level = levelRaw === 'error' || levelRaw === 'warn' ? levelRaw : 'info';
    const convRaw = typeof entry.conv === 'string' ? entry.conv.trim() : '';
    const record = {
      ts: entry.ts || new Date().toISOString(),
      level,
      source: sanitizeLogString(entry.source || 'core', 40),
      event: sanitizeLogString(entry.event || 'event', 80),
      ok: entry.ok !== undefined ? Boolean(entry.ok) : level !== 'error',
    };
    if (Number.isFinite(entry.durationMs)) {
      record.durationMs = Math.max(0, Math.round(entry.durationMs));
    }
    if (convRaw) {
      record.conv = convRaw.slice(0, 8);
    }
    if (entry.message) {
      record.message = sanitizeLogString(entry.message, 320);
    }
    if (entry.detail !== undefined) {
      record.detail = sanitizeLogValue(entry.detail);
    }
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function parseJsonlFile(filePath) {
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, 'utf8');
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') out.push(parsed);
      } catch {
        // skip corrupted line gracefully
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function readFlightEvents(
  dataDir,
  { limit = 80, level = '', source = '', sinceMs = 0, includeRotated = true } = {}
) {
  if (!dataDir) return [];
  const logPath = getFlightLogPath(dataDir);
  const files = includeRotated ? [`${logPath}.1`, logPath] : [logPath];
  const all = [];
  for (const f of files) {
    for (const ev of parseJsonlFile(f)) {
      all.push(ev);
    }
  }
  const wantLevel = String(level || '').toLowerCase();
  const wantSource = String(source || '').toLowerCase();
  const filtered = all.filter((ev) => {
    if (wantLevel === 'warn_or_error') {
      if (ev.level !== 'warn' && ev.level !== 'error') return false;
    } else if (wantLevel && String(ev.level || '').toLowerCase() !== wantLevel) {
      return false;
    }
    if (wantSource && String(ev.source || '').toLowerCase() !== wantSource) {
      return false;
    }
    if (sinceMs > 0) {
      const t = Date.parse(ev.ts || '');
      if (Number.isFinite(t) && t < sinceMs) return false;
    }
    return true;
  });
  filtered.reverse();
  const cap = Math.max(1, Math.min(500, Number(limit) || 80));
  return filtered.slice(0, cap);
}

export function summarizeFlightEvents(dataDir, { windowMs = 24 * 3600 * 1000 } = {}) {
  const sinceMs = windowMs > 0 ? Date.now() - windowMs : 0;
  const events = readFlightEvents(dataDir, { limit: 500, sinceMs, includeRotated: true });
  const byLevel = { info: 0, warn: 0, error: 0 };
  const bySource = {};
  let slowCount = 0;
  let guardBlockedCount = 0;
  let wakeSkippedCount = 0;
  const recentErrors = [];

  for (const ev of events) {
    const lv = ev.level === 'error' || ev.level === 'warn' ? ev.level : 'info';
    byLevel[lv] += 1;
    const src = ev.source || 'unknown';
    bySource[src] = (bySource[src] || 0) + 1;
    if (
      ev.event === 'slow_hook' ||
      ev.event === 'slow_api' ||
      (Number.isFinite(ev.durationMs) && ev.durationMs >= SLOW_OP_THRESHOLD_MS)
    ) {
      slowCount += 1;
    }
    if (ev.event === 'write_guard_triggered') {
      guardBlockedCount += 1;
    }
    if (ev.event === 'stop_wake_skipped') {
      wakeSkippedCount += 1;
    }
    if (lv === 'error' && recentErrors.length < 10) {
      recentErrors.push(ev);
    }
  }

  return {
    total: events.length,
    windowHours: Math.round((windowMs / (3600 * 1000)) * 10) / 10,
    byLevel,
    bySource,
    slowCount,
    guardBlockedCount,
    wakeSkippedCount,
    recentErrors,
    logPath: dataDir ? getFlightLogPath(dataDir) : '',
  };
}

export function clearFlightLogs(dataDir, { maxFiles = DEFAULT_LOG_MAX_FILES } = {}) {
  if (!dataDir) return false;
  const logPath = getFlightLogPath(dataDir);
  const targets = [logPath];
  for (let i = 1; i < Math.max(2, maxFiles); i += 1) {
    targets.push(`${logPath}.${i}`);
  }
  for (const t of targets) {
    if (existsSync(t)) {
      try {
        unlinkSync(t);
      } catch {
        // ignore
      }
    }
  }
  return true;
}
