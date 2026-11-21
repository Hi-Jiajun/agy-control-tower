import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const PLUGIN_JSON_PATH = join(PLUGIN_ROOT, 'plugin.json');
const TEMPLATES_PATH = join(PLUGIN_ROOT, 'skills', 'control-tower', 'references', 'templates.md');

const DATA_DIR = resolve(
  process.env.AGY_CONTROL_TOWER_DATA_DIR ||
    process.env.PLUGIN_DATA ||
    join(homedir(), '.local', 'share', 'agy-control-tower')
);
const APP_DATA_DIR = resolve(
  process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity')
);
const RECENT_PATH = join(DATA_DIR, 'recent-workspaces.json');

const REGISTRY_CANDIDATES = [
  '.agents/SESSION-REGISTRY.md',
  'research/SESSION-REGISTRY.md',
  'SESSION-REGISTRY.md',
];
const ALLOWED_REGISTRY_SET = new Set(REGISTRY_CANDIDATES);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const CONV_LINK_RE = /conversation:\/\/([A-Za-z0-9][A-Za-z0-9_-]{3,127})/;
const BACKTICK_RE = /`([^`\n]+)`/g;
const PLACEHOLDER_RE = /^(\[.*\]|<.*>|暂无|-+|NONE|IDLE|ONLINE|OFFLINE)$/i;

class HttpError extends Error {
  constructor(status, message, extra = null) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function findPreloadJs() {
  const candidates = [
    process.env.ANTIGRAVITY_APP_DATA_DIR &&
      join(process.env.ANTIGRAVITY_APP_DATA_DIR, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
    join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return readFileSync(p, 'utf8');
      } catch {}
    }
  }
  return '';
}

function readPluginMeta() {
  try {
    const raw = JSON.parse(readFileSync(PLUGIN_JSON_PATH, 'utf8'));
    return {
      name: raw.name || 'control-tower',
      displayName: raw.displayName || 'Control Tower',
      version: raw.version || '1.0.0',
    };
  } catch {
    return { name: 'control-tower', displayName: 'Control Tower', version: '1.0.0' };
  }
}

function extractTemplates() {
  const fallback = {
    registrySkeleton: '# 跨会话调度总账与资源租约登记表（SESSION-REGISTRY）\n',
    bootstrapPrompt: '',
    handoverTemplate: '',
    dispatchOfflineTemplate: '',
    dispatchGrantTemplate: '',
  };
  if (!existsSync(TEMPLATES_PATH)) return fallback;
  try {
    const md = readFileSync(TEMPLATES_PATH, 'utf8');
    const getCodeBlockAfter = (headingPattern) => {
      const idx = md.search(headingPattern);
      if (idx < 0) return '';
      const sub = md.slice(idx);
      const m = sub.match(/```(?:markdown|text)?\n([\s\S]*?)\n```/);
      return m ? m[1] : '';
    };
    return {
      registrySkeleton: getCodeBlockAfter(/^## 1\./m) || fallback.registrySkeleton,
      bootstrapPrompt: getCodeBlockAfter(/^## 2\./m),
      handoverTemplate: getCodeBlockAfter(/^## 3\./m),
      dispatchOfflineTemplate: getCodeBlockAfter(/^### 4\.1/m),
      dispatchGrantTemplate: getCodeBlockAfter(/^### 4\.2/m),
    };
  } catch {
    return fallback;
  }
}

function normalizeWorkspaceInput(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text) return null;
  if (text.startsWith('file://')) {
    try {
      text = fileURLToPath(text);
    } catch {
      throw new HttpError(400, 'Invalid workspace file URI');
    }
  }
  const abs = resolve(text);
  if (!existsSync(abs)) {
    throw new HttpError(400, 'Workspace directory does not exist');
  }
  const real = realpathSync(abs);
  if (!statSync(real).isDirectory()) {
    throw new HttpError(400, 'Workspace path is not a directory');
  }
  return real;
}

function resolveRegistryTarget(wsReal, relPath, { allowMissing = false } = {}) {
  if (typeof relPath !== 'string' || !ALLOWED_REGISTRY_SET.has(relPath)) {
    throw new HttpError(403, 'Registry path must be one of .agents/SESSION-REGISTRY.md, research/SESSION-REGISTRY.md, or SESSION-REGISTRY.md');
  }
  const candidate = resolve(wsReal, relPath);
  const rel = relative(wsReal, candidate);
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new HttpError(403, 'Path traversal blocked');
  }
  const parent = dirname(candidate);
  if (existsSync(parent)) {
    const parentReal = realpathSync(parent);
    const parentRel = relative(wsReal, parentReal);
    if (parentRel.startsWith('..')) {
      throw new HttpError(403, 'Parent symlink escapes workspace');
    }
  }
  if (existsSync(candidate)) {
    const lst = lstatSync(candidate);
    if (lst.isSymbolicLink()) {
      const targetReal = realpathSync(candidate);
      const tRel = relative(wsReal, targetReal);
      if (tRel.startsWith('..')) {
        throw new HttpError(403, 'Registry symlink escapes workspace');
      }
    }
  } else if (!allowMissing) {
    throw new HttpError(404, 'SESSION-REGISTRY.md not found');
  }
  return candidate;
}

function findExistingRegistry(wsReal) {
  for (const relPath of REGISTRY_CANDIDATES) {
    const p = resolve(wsReal, relPath);
    if (existsSync(p)) {
      const target = resolveRegistryTarget(wsReal, relPath, { allowMissing: false });
      if (statSync(target).isFile()) {
        return { relPath, absPath: target };
      }
    }
  }
  return null;
}

function loadRecentWorkspaces() {
  if (!existsSync(RECENT_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(RECENT_PATH, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((item) => typeof item === 'string' && existsSync(item));
  } catch {
    return [];
  }
}

function recordRecentWorkspace(wsReal) {
  try {
    const existing = loadRecentWorkspaces().filter((p) => p !== wsReal);
    const next = [wsReal, ...existing].slice(0, 12);
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = join(DATA_DIR, `.recent.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(tmp, RECENT_PATH);
    return next;
  } catch {
    return [wsReal];
  }
}

function atomicWriteFile(targetPath, content) {
  const parent = dirname(targetPath);
  mkdirSync(parent, { recursive: true });
  const tmp = join(parent, `.SESSION-REGISTRY.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, targetPath);
}

function extractConvId(cell) {
  if (!cell) return '';
  const m = cell.match(CONV_LINK_RE);
  if (m) return m[1].trim();
  const matches = cell.matchAll(BACKTICK_RE);
  for (const hit of matches) {
    const t = hit[1].trim();
    if (!t || PLACEHOLDER_RE.test(t)) continue;
    if (/^[A-Za-z0-9][A-Za-z0-9_-]{3,127}$/.test(t)) return t;
  }
  const stripped = cell.replace(/[`*_\s]/g, '');
  if (stripped && !PLACEHOLDER_RE.test(stripped) && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(stripped)) {
    return stripped;
  }
  return '';
}

function splitMdRow(line) {
  const s = line.trim();
  if (!s.startsWith('|') || !s.endsWith('|')) return null;
  return s.slice(1, -1).split('|').map((c) => c.trim());
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s+/g, '')));
}

function stripMd(text) {
  let s = (text || '').trim();
  if (s.startsWith('**') && s.endsWith('**') && s.length > 4) s = s.slice(2, -2).trim();
  if (s.startsWith('`') && s.endsWith('`') && s.length > 2) s = s.slice(1, -1).trim();
  return s;
}

function parseRegistry(mdText) {
  const result = {
    lease: {
      lockStatus: '',
      holder: '',
      resource: '',
      since: '',
      scope: '',
      releaseCriteria: '',
    },
    controller: {
      currentControllerId: '',
      currentControllerStatus: '',
      defaultModel: '',
      handoverHistory: [],
    },
    activeSessions: [],
    archivedSessions: [],
    queue: [],
  };

  let section = '';
  let subsection = '';
  let inTable = false;
  let tableHeader = [];

  for (const rawLine of mdText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('## ')) {
      inTable = false;
      tableHeader = [];
      subsection = '';
      if (line.includes('独占资源租约') || line.includes('Exclusive Resource Lease')) section = 'lease';
      else if (line.includes('常驻主交流总控') || line.includes('Control Tower')) section = 'controller';
      else if (line.includes('活跃') || line.includes('挂起')) section = 'active';
      else if (line.includes('归档')) section = 'archived';
      else if (line.includes('待调度') || line.includes('队列')) section = 'queue';
      else section = 'other';
      continue;
    }
    if (line.startsWith('### ')) {
      inTable = false;
      tableHeader = [];
      subsection = line.slice(4).trim();
      continue;
    }
    if (section === 'controller' && line.startsWith('- ')) {
      if (line.includes('当前现役总控会话')) {
        result.controller.currentControllerId = extractConvId(line);
        const stM = line.match(/状态[：:]\s*`?([A-Za-z0-9_-]+)`?/);
        if (stM) result.controller.currentControllerStatus = stM[1];
      } else if (line.includes('常驻模型配置')) {
        result.controller.defaultModel = line.replace(/^-\s*\*\*常驻模型配置\*\*[：:]\s*/, '').trim();
      }
      continue;
    }

    const cells = splitMdRow(line);
    if (!cells) {
      if (line && !line.startsWith('>') && !line.startsWith('---')) {
        inTable = false;
        tableHeader = [];
      }
      continue;
    }
    if (!inTable) {
      tableHeader = cells.map(stripMd);
      inTable = true;
      continue;
    }
    if (isSeparatorRow(cells)) continue;
    while (cells.length < tableHeader.length) cells.push('');

    if (section === 'lease' && cells.length >= 2) {
      const k = stripMd(cells[0]);
      const v = stripMd(cells[1]);
      if (k.includes('锁状态')) result.lease.lockStatus = v;
      else if (k.includes('持锁会话')) result.lease.holder = v;
      else if (k.includes('独占对象')) result.lease.resource = v;
      else if (k.includes('起始时间')) result.lease.since = v;
      else if (k.includes('操作范围') || k.includes('保护现场')) result.lease.scope = v;
      else if (k.includes('解锁判据')) result.lease.releaseCriteria = v;
    } else if (section === 'controller' && subsection.includes('换届历史') && cells.length >= 5) {
      result.controller.handoverHistory.push({
        term: stripMd(cells[0]),
        conversationId: extractConvId(cells[1]) || stripMd(cells[1]),
        model: stripMd(cells[2]),
        period: stripMd(cells[3]),
        summary: stripMd(cells[4]),
      });
    } else if (section === 'active' && cells.length >= 6) {
      const first = stripMd(cells[0]);
      if (!first || first === '暂无' || first === '-') continue;
      result.activeSessions.push({
        rawCell: cells[0],
        conversationId: extractConvId(cells[0]),
        topic: stripMd(cells[1]),
        modelTool: stripMd(cells[2]),
        lockStatus: stripMd(cells[3]),
        status: stripMd(cells[4]),
        paths: stripMd(cells[5]),
      });
    } else if (section === 'archived' && cells.length >= 3) {
      const first = stripMd(cells[0]);
      if (!first || first === '暂无' || first === '-') continue;
      result.archivedSessions.push({
        rawCell: cells[0],
        conversationId: extractConvId(cells[0]),
        milestone: stripMd(cells[1]),
        summary: stripMd(cells[2]),
      });
    } else if (section === 'queue' && cells.length >= 4) {
      const first = stripMd(cells[0]);
      if (!first || first === '暂无' || first === '-') continue;
      result.queue.push({
        id: first,
        summary: stripMd(cells[1]),
        status: stripMd(cells[2]),
        route: stripMd(cells[3]),
      });
    }
  }
  return result;
}

function resolveBrainTranscript(idOrPrefix) {
  const cand = (idOrPrefix || '').trim();
  if (!ID_RE.test(cand)) return { status: 'invalid', conversationId: '', path: null, matches: [] };
  const brainDir = join(APP_DATA_DIR, 'brain');
  if (!existsSync(brainDir)) return { status: 'missing', conversationId: '', path: null, matches: [] };
  const brainReal = realpathSync(brainDir);

  const exactPath = join(brainReal, cand, '.system_generated', 'logs', 'transcript.jsonl');
  if (existsSync(exactPath)) {
    const exactReal = realpathSync(exactPath);
    if (!relative(brainReal, exactReal).startsWith('..') && statSync(exactReal).isFile()) {
      return { status: 'ok', conversationId: cand, path: exactReal, matches: [cand] };
    }
  }

  const hits = [];
  for (const ent of readdirSync(brainReal, { withFileTypes: true })) {
    if (!ent.isDirectory() || !ent.name.startsWith(cand)) continue;
    const tp = join(brainReal, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(tp)) {
      const tpReal = realpathSync(tp);
      if (!relative(brainReal, tpReal).startsWith('..') && statSync(tpReal).isFile()) {
        hits.push({ conversationId: ent.name, path: tpReal });
      }
    }
  }
  hits.sort((a, b) => a.conversationId.localeCompare(b.conversationId));
  if (hits.length === 1) return { status: 'ok', conversationId: hits[0].conversationId, path: hits[0].path, matches: [hits[0].conversationId] };
  if (hits.length > 1) return { status: 'ambiguous', conversationId: '', path: null, matches: hits.map((h) => h.conversationId) };
  return { status: 'missing', conversationId: '', path: null, matches: [] };
}

function cleanGoal(raw) {
  if (typeof raw !== 'string') return '';
  const m = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  const text = (m ? m[1] : raw).replace(/\s+/g, ' ').trim();
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

function inspectTranscriptFile(tp) {
  const info = {
    exists: false,
    lineCount: 0,
    maxStepIndex: 0,
    goal: '',
    lastModel: '',
    lastUpdatedAt: '',
    lastStatus: '',
    lastError: '',
    compactions: 0,
  };
  if (!tp || !existsSync(tp)) return info;
  info.exists = true;
  let explicitCompactions = 0;
  let tokenDrops = 0;
  const prevUsedByModel = new Map();

  try {
    const raw = readFileSync(tp, 'utf8');
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let step;
      try {
        step = JSON.parse(line);
      } catch {
        continue;
      }
      if (!step || typeof step !== 'object') continue;
      info.lineCount += 1;
      if (Number.isInteger(step.step_index) && step.step_index > info.maxStepIndex) {
        info.maxStepIndex = step.step_index;
      }
      const stype = String(step.type || '').toUpperCase();
      if (!info.goal && stype === 'USER_INPUT') {
        info.goal = cleanGoal(step.content || '');
      }
      if (typeof step.model === 'string' && step.model.trim()) {
        info.lastModel = step.model.trim();
      }
      if (typeof step.created_at === 'string' && step.created_at.trim()) {
        info.lastUpdatedAt = step.created_at.trim();
      }
      if (typeof step.status === 'string' && step.status.trim()) {
        info.lastStatus = step.status.trim();
      }
      if (typeof step.error === 'string' && step.error.trim()) {
        info.lastError = step.error.trim().slice(0, 120);
      }
      if (
        stype.includes('CHECKPOINT') ||
        stype.includes('COMPACTION') ||
        stype.includes('CONVERSATION_SUMMARY') ||
        step.is_checkpoint
      ) {
        explicitCompactions += 1;
      }
      if (stype === 'PLANNER_RESPONSE' || 'input_tokens' in step || 'cache_read_tokens' in step) {
        const inTok = Number(step.input_tokens || 0);
        const cacheTok = Number(step.cache_read_tokens || 0);
        if (Number.isFinite(inTok) && Number.isFinite(cacheTok)) {
          const used = inTok + cacheTok;
          if (used > 0) {
            const mkey = (typeof step.model === 'string' && step.model.trim()) || '_default';
            const prevUsed = prevUsedByModel.get(mkey) || 0;
            if (prevUsed > 0 && used < prevUsed * 0.72 && prevUsed - used > 30000) {
              tokenDrops += 1;
            }
            prevUsedByModel.set(mkey, used);
          }
        }
      }
    }
  } catch {}
  info.compactions = Math.max(explicitCompactions, tokenDrops);
  return info;
}

function inspectById(convId) {
  if (!convId || !ID_RE.test(convId)) return null;
  const res = resolveBrainTranscript(convId);
  if (res.status !== 'ok') return { exists: false, conversationId: convId, status: res.status };
  return { conversationId: res.conversationId, ...inspectTranscriptFile(res.path) };
}

function sanitizeCell(val, { backtick = false } = {}) {
  const clean = String(val ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '/').trim() || '-';
  if (!backtick) return clean;
  if (clean.startsWith('`') && clean.endsWith('`')) return clean;
  return `\`${clean.replace(/`/g, '')}\``;
}

function updateLeaseSection(mdText, patch) {
  const lines = mdText.split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (start < 0) {
      if (t.startsWith('## ') && (t.includes('独占资源租约') || t.includes('Exclusive Resource Lease'))) {
        start = i;
      }
    } else if (t.startsWith('## ')) {
      end = i;
      break;
    }
  }
  if (start < 0) {
    throw new HttpError(400, 'Current SESSION-REGISTRY.md has no Section 1 Exclusive Resource Lease table');
  }

  let updated = false;
  for (let i = start + 1; i < end; i++) {
    const cells = splitMdRow(lines[i]);
    if (!cells || cells.length < 2 || isSeparatorRow(cells)) continue;
    const key = stripMd(cells[0]);
    if (key.includes('锁状态') && patch.lockStatus !== undefined) {
      lines[i] = `| ${cells[0]} | ${sanitizeCell(patch.lockStatus, { backtick: true })} |`;
      updated = true;
    } else if (key.includes('持锁会话') && patch.holder !== undefined) {
      lines[i] = `| ${cells[0]} | ${sanitizeCell(patch.holder, { backtick: patch.holder !== '-' })} |`;
      updated = true;
    } else if (key.includes('独占对象') && patch.resource !== undefined) {
      lines[i] = `| ${cells[0]} | ${sanitizeCell(patch.resource)} |`;
      updated = true;
    } else if (key.includes('起始时间') && patch.since !== undefined) {
      lines[i] = `| ${cells[0]} | ${sanitizeCell(patch.since, { backtick: patch.since !== '-' })} |`;
      updated = true;
    } else if ((key.includes('操作范围') || key.includes('保护现场')) && patch.scope !== undefined) {
      lines[i] = `| ${cells[0]} | ${sanitizeCell(patch.scope)} |`;
      updated = true;
    } else if (key.includes('解锁判据') && patch.releaseCriteria !== undefined) {
      lines[i] = `| ${cells[0]} | ${sanitizeCell(patch.releaseCriteria, { backtick: true })} |`;
      updated = true;
    }
  }
  if (!updated) {
    throw new HttpError(400, 'No lease fields matched in Section 1');
  }
  return lines.join('\n');
}

function findQueueTableBounds(lines) {
  let secStart = -1;
  let secEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (secStart < 0) {
      if (t.startsWith('## ') && (t.includes('待调度') || t.includes('队列'))) secStart = i;
    } else if (t.startsWith('## ')) {
      secEnd = i;
      break;
    }
  }
  if (secStart < 0) {
    throw new HttpError(400, 'Current SESSION-REGISTRY.md has no Section 5 Task Queue table');
  }
  let sepIdx = -1;
  let tableEnd = secEnd;
  for (let i = secStart + 1; i < secEnd; i++) {
    const cells = splitMdRow(lines[i]);
    if (cells && isSeparatorRow(cells)) {
      sepIdx = i;
      continue;
    }
    if (sepIdx >= 0 && !cells) {
      tableEnd = i;
      break;
    }
  }
  if (sepIdx < 0) {
    throw new HttpError(400, 'Malformed Section 5 Task Queue table');
  }
  return { sepIdx, tableEnd };
}

function upsertQueueRow(mdText, item) {
  const idClean = sanitizeCell(item.id, { backtick: false });
  if (!idClean || idClean === '-' || idClean === '暂无') {
    throw new HttpError(400, 'Task ID is required');
  }
  const origClean = item.originalId ? sanitizeCell(item.originalId, { backtick: false }) : idClean;
  const newLine = `| ${sanitizeCell(idClean, { backtick: true })} | ${sanitizeCell(item.summary)} | ${sanitizeCell(item.status || 'QUEUED', { backtick: true })} | ${sanitizeCell(item.route || 'L2 Orchestrator (Neon)')} |`;

  const lines = mdText.split(/\r?\n/);
  const { sepIdx, tableEnd } = findQueueTableBounds(lines);
  const kept = [];
  let replaced = false;
  for (let i = sepIdx + 1; i < tableEnd; i++) {
    const cells = splitMdRow(lines[i]);
    if (!cells) continue;
    const rowId = stripMd(cells[0]);
    if (rowId === '暂无' || rowId === '-') continue;
    if (rowId === origClean || rowId === idClean) {
      if (!replaced) {
        kept.push(newLine);
        replaced = true;
      }
    } else {
      kept.push(lines[i]);
    }
  }
  if (!replaced) kept.push(newLine);
  lines.splice(sepIdx + 1, tableEnd - (sepIdx + 1), ...kept);
  return lines.join('\n');
}

function deleteQueueRow(mdText, id) {
  const targetId = sanitizeCell(id, { backtick: false });
  if (!targetId) throw new HttpError(400, 'Task ID is required');
  const lines = mdText.split(/\r?\n/);
  const { sepIdx, tableEnd } = findQueueTableBounds(lines);
  const kept = [];
  let removed = false;
  for (let i = sepIdx + 1; i < tableEnd; i++) {
    const cells = splitMdRow(lines[i]);
    if (!cells) continue;
    const rowId = stripMd(cells[0]);
    if (rowId === targetId) {
      removed = true;
      continue;
    }
    if (rowId && rowId !== '暂无' && rowId !== '-') kept.push(lines[i]);
  }
  if (!removed) throw new HttpError(404, `Task ${targetId} not found in queue`);
  if (kept.length === 0) kept.push('| `暂无` | - | - | - |');
  lines.splice(sepIdx + 1, tableEnd - (sepIdx + 1), ...kept);
  return lines.join('\n');
}

function buildSnapshot(wsRaw) {
  const plugin = readPluginMeta();
  const templates = extractTemplates();
  const recent = loadRecentWorkspaces();
  const wsReal = wsRaw ? normalizeWorkspaceInput(wsRaw) : (recent[0] || null);

  if (!wsReal) {
    return {
      plugin,
      workspace: '',
      recentWorkspaces: recent,
      registryExists: false,
      registryRelPath: '',
      registryPath: '',
      hash: '',
      content: '',
      parsed: parseRegistry(''),
      templates,
    };
  }

  const nextRecent = recordRecentWorkspace(wsReal);
  const found = findExistingRegistry(wsReal);
  if (!found) {
    return {
      plugin,
      workspace: wsReal,
      recentWorkspaces: nextRecent,
      registryExists: false,
      registryRelPath: '',
      registryPath: '',
      hash: '',
      content: '',
      parsed: parseRegistry(''),
      templates,
    };
  }

  const content = readFileSync(found.absPath, 'utf8');
  const parsed = parseRegistry(content);
  if (parsed.controller.currentControllerId) {
    parsed.controller.telemetry = inspectById(parsed.controller.currentControllerId);
  }
  parsed.activeSessions = parsed.activeSessions.map((s) => ({
    ...s,
    telemetry: s.conversationId ? inspectById(s.conversationId) : null,
  }));

  return {
    plugin,
    workspace: wsReal,
    recentWorkspaces: nextRecent,
    registryExists: true,
    registryRelPath: found.relPath,
    registryPath: found.absPath,
    hash: sha256(content),
    content,
    parsed,
    templates,
  };
}

function loadRegistryForMutation(body) {
  const wsReal = normalizeWorkspaceInput(body.workspace);
  if (!wsReal) throw new HttpError(400, 'workspace is required');
  let target = null;
  if (body.relPath) {
    target = { relPath: body.relPath, absPath: resolveRegistryTarget(wsReal, body.relPath, { allowMissing: false }) };
  } else {
    target = findExistingRegistry(wsReal);
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
  return { wsReal, target, content, currentHash };
}

class ControlTowerServer {
  #port;
  #token;
  #staticAssets;

  constructor() {
    this.#port = Number.parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '0', 10);
    if (!Number.isInteger(this.#port) || this.#port < 0 || this.#port > 65535) {
      throw new Error('Invalid ANTIGRAVITY_SIDECAR_WEB_PORT');
    }
    this.#token = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
    this.#staticAssets = new Map([
      ['/', { file: join(__dirname, 'index.html'), type: 'text/html; charset=utf-8' }],
      ['/index.html', { file: join(__dirname, 'index.html'), type: 'text/html; charset=utf-8' }],
      ['/styles.css', { file: join(__dirname, 'styles.css'), type: 'text/css; charset=utf-8' }],
      ['/app.js', { file: join(__dirname, 'app.js'), type: 'application/javascript; charset=utf-8' }],
    ]);
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

  async #handleApi(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/snapshot') {
      const snap = buildSnapshot(url.searchParams.get('workspace') || '');
      return this.#sendJson(res, 200, snap);
    }
    if (req.method === 'GET' && url.pathname === '/api/session/inspect') {
      const q = (url.searchParams.get('id') || '').trim();
      const resInspect = resolveBrainTranscript(q);
      if (resInspect.status !== 'ok') {
        return this.#sendJson(res, 200, {
          status: resInspect.status,
          conversationId: resInspect.conversationId,
          matches: resInspect.matches,
          info: null,
        });
      }
      return this.#sendJson(res, 200, {
        status: 'ok',
        conversationId: resInspect.conversationId,
        matches: resInspect.matches,
        info: inspectTranscriptFile(resInspect.path),
      });
    }
    if (req.method !== 'POST') {
      return this.#sendJson(res, 405, { error: 'Method Not Allowed' });
    }

    const body = await this.#readBody(req);
    if (url.pathname === '/api/registry/init') {
      const wsReal = normalizeWorkspaceInput(body.workspace);
      if (!wsReal) throw new HttpError(400, 'workspace is required');
      const relPath = body.relPath || '.agents/SESSION-REGISTRY.md';
      const target = resolveRegistryTarget(wsReal, relPath, { allowMissing: true });
      if (existsSync(target)) {
        throw new HttpError(409, `Target already exists: ${relPath}`);
      }
      const { registrySkeleton } = extractTemplates();
      atomicWriteFile(target, `${registrySkeleton.trimEnd()}\n`);
      return this.#sendJson(res, 200, { ok: true, snapshot: buildSnapshot(wsReal) });
    }

    if (url.pathname === '/api/lease/update') {
      const { wsReal, target, content } = loadRegistryForMutation(body);
      const patch =
        body.action === 'release'
          ? {
              lockStatus: 'IDLE（空闲待分配）',
              holder: '-',
              since: '-',
              ...(body.resource !== undefined ? { resource: body.resource } : {}),
              ...(body.scope !== undefined ? { scope: body.scope } : {}),
              ...(body.releaseCriteria !== undefined ? { releaseCriteria: body.releaseCriteria } : {}),
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
      atomicWriteFile(target.absPath, next.endsWith('\n') ? next : `${next}\n`);
      return this.#sendJson(res, 200, { ok: true, snapshot: buildSnapshot(wsReal) });
    }

    if (url.pathname === '/api/queue/upsert') {
      const { wsReal, target, content } = loadRegistryForMutation(body);
      const next = upsertQueueRow(content, body);
      atomicWriteFile(target.absPath, next.endsWith('\n') ? next : `${next}\n`);
      return this.#sendJson(res, 200, { ok: true, snapshot: buildSnapshot(wsReal) });
    }

    if (url.pathname === '/api/queue/delete') {
      const { wsReal, target, content } = loadRegistryForMutation(body);
      const next = deleteQueueRow(content, body.id);
      atomicWriteFile(target.absPath, next.endsWith('\n') ? next : `${next}\n`);
      return this.#sendJson(res, 200, { ok: true, snapshot: buildSnapshot(wsReal) });
    }

    if (url.pathname === '/api/registry/save') {
      const { wsReal, target } = loadRegistryForMutation(body);
      if (typeof body.content !== 'string') {
        throw new HttpError(400, 'content must be a string');
      }
      if (Buffer.byteLength(body.content, 'utf8') > MAX_FILE_BYTES) {
        throw new HttpError(413, 'SESSION-REGISTRY.md exceeds 512KB cap');
      }
      atomicWriteFile(target.absPath, body.content);
      return this.#sendJson(res, 200, { ok: true, snapshot: buildSnapshot(wsReal) });
    }

    return this.#sendJson(res, 404, { error: 'Not Found' });
  }

  start() {
    const preloadJs = findPreloadJs();
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      if (req.method !== 'GET' && !this.#validToken(req, url)) {
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

      if (url.pathname.startsWith('/api/')) {
        try {
          await this.#handleApi(req, res, url);
        } catch (err) {
          if (err instanceof HttpError) {
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

    server.listen(this.#port, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        console.log(`control-tower sidecar listening on http://127.0.0.1:${addr.port}`);
      }
    });
  }
}

new ControlTowerServer().start();
