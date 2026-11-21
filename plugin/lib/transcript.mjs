import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  atomicWriteText,
  readJsonSafe,
  resolveAppDataDirs,
  sha256,
} from './paths.mjs';

const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 64 * 1024;
const CHUNK_BYTES = 64 * 1024;
const STATE_MAX_ENTRIES = 200;

export const HEX_CONV_ID_RE =
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f-]{0,28})$/i;

const HEX_CANDIDATE_GLOBAL_RE =
  /(?<![A-Za-z0-9_-])([0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|-[0-9a-f-]{1,27}|[0-9a-f]{0,24}))(?![A-Za-z0-9_-])/gi;

export function isValidConvIdOrPrefix(token) {
  if (typeof token !== 'string') return false;
  const trimmed = token.trim();
  if (!HEX_CONV_ID_RE.test(trimmed)) return false;
  const hexOnly = trimmed.replace(/-/g, '');
  return hexOnly.length >= 8 && hexOnly.length <= 32;
}

/**
 * Extract conversation IDs or 8+ hex prefixes from bare ID or short command prompts.
 * Ignores fenced/inline code blocks and oversized prompts.
 */
export function extractPromptSessionIds(
  rawInput,
  { maxCandidates = 3, maxInputLength = 400 } = {}
) {
  if (typeof rawInput !== 'string') {
    return { isSingleBareId: false, ids: [] };
  }
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { isSingleBareId: false, ids: [] };
  }
  if (isValidConvIdOrPrefix(trimmed)) {
    return { isSingleBareId: true, ids: [trimmed] };
  }

  const stripped = trimmed
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .trim();

  if (!stripped || stripped.length > maxInputLength) {
    return { isSingleBareId: false, ids: [] };
  }

  const ids = [];
  const seen = new Set();
  for (const m of stripped.matchAll(HEX_CANDIDATE_GLOBAL_RE)) {
    const cand = m[1];
    if (!isValidConvIdOrPrefix(cand)) continue;
    const key = cand.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(cand);
    if (ids.length >= maxCandidates) break;
  }

  return { isSingleBareId: false, ids };
}

function isInsideDir(rootReal, targetReal) {
  const rel = relative(rootReal, targetReal);
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`));
}

export function resolveBrainTranscript(idOrPrefix, { env = process.env, hintPath = '' } = {}) {
  const cand = typeof idOrPrefix === 'string' ? idOrPrefix.trim() : '';
  if (!isValidConvIdOrPrefix(cand)) {
    return { status: 'invalid', conversationId: '', path: null, matches: [] };
  }
  const candLower = cand.toLowerCase();
  const appDirs = resolveAppDataDirs({ env, hintPath });

  const exactHits = [];
  const prefixHits = new Map();

  for (const appDir of appDirs) {
    const brainDir = join(appDir, 'brain');
    if (!existsSync(brainDir)) continue;
    let brainReal;
    try {
      brainReal = realpathSync(brainDir);
    } catch {
      continue;
    }

    const exactPath = join(brainReal, cand, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(exactPath)) {
      try {
        const exactReal = realpathSync(exactPath);
        if (isInsideDir(brainReal, exactReal) && statSync(exactReal).isFile()) {
          exactHits.push({ conversationId: cand, path: exactReal });
        }
      } catch {
        // ignore unreadable
      }
    }

    let entries = [];
    try {
      entries = readdirSync(brainReal, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (!ent.name.toLowerCase().startsWith(candLower)) continue;
      const tp = join(brainReal, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (!existsSync(tp)) continue;
      try {
        const tpReal = realpathSync(tp);
        if (isInsideDir(brainReal, tpReal) && statSync(tpReal).isFile()) {
          if (!prefixHits.has(ent.name)) {
            prefixHits.set(ent.name, tpReal);
          }
        }
      } catch {
        // ignore unreadable
      }
    }
  }

  if (exactHits.length > 0) {
    return {
      status: 'ok',
      conversationId: exactHits[0].conversationId,
      path: exactHits[0].path,
      matches: [exactHits[0].conversationId],
    };
  }

  const hits = [...prefixHits.entries()]
    .map(([conversationId, path]) => ({ conversationId, path }))
    .sort((a, b) => a.conversationId.localeCompare(b.conversationId));

  if (hits.length === 1) {
    return {
      status: 'ok',
      conversationId: hits[0].conversationId,
      path: hits[0].path,
      matches: [hits[0].conversationId],
    };
  }
  if (hits.length > 1) {
    return {
      status: 'ambiguous',
      conversationId: '',
      path: null,
      matches: hits.map((h) => h.conversationId),
    };
  }
  return { status: 'missing', conversationId: '', path: null, matches: [] };
}

export function cleanGoal(raw) {
  if (typeof raw !== 'string') return '';
  const m = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  const text = (m ? m[1] : raw).replace(/\s+/g, ' ').trim();
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

function readRangeSync(fd, offset, length) {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(length);
  let total = 0;
  while (total < length) {
    const n = readSync(fd, buf, total, length - total, offset + total);
    if (n <= 0) break;
    total += n;
  }
  return total === length ? buf : buf.subarray(0, total);
}

function recordCompactionEvent(acc, kind) {
  const line = acc.lineCount;
  // Deduplicate an explicit compaction event immediately followed within 2 lines by a token drop (or vice versa)
  if (
    acc.lastCompactionLine > 0 &&
    line - acc.lastCompactionLine <= 2 &&
    acc.lastCompactionKind !== kind
  ) {
    acc.lastCompactionLine = line;
    acc.lastCompactionKind = kind;
    return;
  }
  acc.compactions += 1;
  acc.lastCompactionLine = line;
  acc.lastCompactionKind = kind;
}

function processStepForCompactions(step, acc) {
  acc.lineCount += 1;
  if (Number.isInteger(step.step_index) && step.step_index > acc.maxStepIndex) {
    acc.maxStepIndex = step.step_index;
  }
  const stype = String(step.type || '').toUpperCase();
  if (
    stype.includes('CHECKPOINT') ||
    stype.includes('COMPACTION') ||
    stype.includes('CONVERSATION_SUMMARY') ||
    step.is_checkpoint
  ) {
    recordCompactionEvent(acc, 'explicit');
  }
  if (stype === 'PLANNER_RESPONSE' || 'input_tokens' in step || 'cache_read_tokens' in step) {
    const inTok = Number(step.input_tokens || 0);
    const cacheTok = Number(step.cache_read_tokens || 0);
    if (Number.isFinite(inTok) && Number.isFinite(cacheTok)) {
      const used = inTok + cacheTok;
      if (used > 0) {
        const mkey = (typeof step.model === 'string' && step.model.trim()) || '_default';
        const prevUsed = acc.prevUsedByModel[mkey] || 0;
        if (prevUsed > 0 && used < prevUsed * 0.72 && prevUsed - used > 30000) {
          recordCompactionEvent(acc, 'token_drop');
        }
        acc.prevUsedByModel[mkey] = used;
      }
    }
  }
}

function scanCompactionsRange(fd, startOffset, endOffset, seedAcc) {
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  let pos = startOffset;
  let leftover = '';
  let lastCompleteOffset = startOffset;

  while (pos < endOffset) {
    const toRead = Math.min(CHUNK_BYTES, endOffset - pos);
    const n = readSync(fd, buf, 0, toRead, pos);
    if (n <= 0) break;
    const chunkText = leftover + buf.subarray(0, n).toString('utf8');
    const lines = chunkText.split('\n');
    const endsWithNewline = chunkText.endsWith('\n');
    const completeLines = endsWithNewline ? lines : lines.slice(0, -1);
    leftover = endsWithNewline ? '' : lines[lines.length - 1];

    const prevLeftoverBytes = Buffer.byteLength(leftover, 'utf8');
    const newTotalRead = pos + n - prevLeftoverBytes;
    if (newTotalRead > lastCompleteOffset) {
      lastCompleteOffset = newTotalRead;
    }

    for (const rawLine of completeLines) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const step = JSON.parse(line);
        if (step && typeof step === 'object') {
          processStepForCompactions(step, seedAcc);
        }
      } catch {
        // skip malformed json line
      }
    }
    pos += n;
  }

  // Handle trailing JSON line lacking a final newline without advancing lastCompleteOffset past it
  if (leftover && leftover.trim()) {
    try {
      const step = JSON.parse(leftover.trim());
      if (step && typeof step === 'object') {
        processStepForCompactions(step, seedAcc);
      }
    } catch {
      // incomplete trailing JSON line
    }
  }

  return lastCompleteOffset;
}

/**
 * Inspect transcript.jsonl using head (32KB), tail (64KB), and byte-offset incremental compaction scan.
 */
export function inspectTranscript(tp, { cacheEntry = null } = {}) {
  const emptyInfo = {
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
  if (!tp || !existsSync(tp)) {
    return { info: emptyInfo, nextCacheEntry: null };
  }

  let st;
  try {
    st = statSync(tp);
  } catch {
    return { info: emptyInfo, nextCacheEntry: null };
  }
  const fileSize = st.size;
  const mtimeMs = Math.trunc(st.mtimeMs);

  if (
    cacheEntry &&
    cacheEntry.size === fileSize &&
    cacheEntry.mtimeMs === mtimeMs &&
    cacheEntry.info
  ) {
    return {
      info: { ...cacheEntry.info, exists: true },
      nextCacheEntry: cacheEntry,
    };
  }

  let fd;
  try {
    fd = openSync(tp, 'r');
    if (fileSize === 0) {
      return {
        info: { ...emptyInfo, exists: true },
        nextCacheEntry: null,
      };
    }

    // 1) Read head up to 32KB for goal & headHash
    const headLen = Math.min(HEAD_BYTES, fileSize);
    const headBuf = readRangeSync(fd, 0, headLen);
    const headHash = sha256(headBuf.subarray(0, Math.min(512, headBuf.length)));
    const headText = headBuf.toString('utf8');
    const headLines = fileSize > headLen ? headText.split('\n').slice(0, -1) : headText.split('\n');
    let goal = '';
    for (const rawLine of headLines) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const step = JSON.parse(line);
        if (step && typeof step === 'object') {
          const stype = String(step.type || '').toUpperCase();
          if (stype === 'USER_INPUT') {
            goal = cleanGoal(step.content || '');
            if (goal) break;
          }
        }
      } catch {
        // skip
      }
    }

    // 2) Read tail up to 64KB for latest status, model, timestamp, error
    const tailOffset = Math.max(0, fileSize - TAIL_BYTES);
    const tailBuf = readRangeSync(fd, tailOffset, fileSize - tailOffset);
    const tailText = tailBuf.toString('utf8');
    const tailLines = tailOffset > 0 ? tailText.split('\n').slice(1) : tailText.split('\n');

    let lastModel = '';
    let lastUpdatedAt = '';
    let lastStatus = '';
    let lastError = '';
    let maxStepIndex = 0;

    for (const rawLine of tailLines) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const step = JSON.parse(line);
        if (!step || typeof step !== 'object') continue;
        if (Number.isInteger(step.step_index) && step.step_index > maxStepIndex) {
          maxStepIndex = step.step_index;
        }
        if (typeof step.model === 'string' && step.model.trim()) {
          lastModel = step.model.trim();
        }
        if (typeof step.created_at === 'string' && step.created_at.trim()) {
          lastUpdatedAt = step.created_at.trim();
        }
        if (typeof step.status === 'string' && step.status.trim()) {
          lastStatus = step.status.trim();
        }
        if (typeof step.error === 'string' && step.error.trim()) {
          lastError = step.error.trim().slice(0, 120);
        }
      } catch {
        // skip partial tail line
      }
    }

    // 3) Incremental compaction scan from cached byte offset (or 0)
    const canResume =
      cacheEntry &&
      cacheEntry.headHash === headHash &&
      Number.isInteger(cacheEntry.offset) &&
      cacheEntry.offset >= 0 &&
      cacheEntry.offset <= fileSize &&
      cacheEntry.acc;

    const acc = canResume
      ? {
          lineCount: cacheEntry.acc.lineCount || 0,
          maxStepIndex: Math.max(cacheEntry.acc.maxStepIndex || 0, maxStepIndex),
          compactions: cacheEntry.acc.compactions || 0,
          lastCompactionLine: cacheEntry.acc.lastCompactionLine || 0,
          lastCompactionKind: cacheEntry.acc.lastCompactionKind || '',
          prevUsedByModel: { ...(cacheEntry.acc.prevUsedByModel || {}) },
        }
      : {
          lineCount: 0,
          maxStepIndex,
          compactions: 0,
          lastCompactionLine: 0,
          lastCompactionKind: '',
          prevUsedByModel: {},
        };

    const startOffset = canResume ? cacheEntry.offset : 0;
    const nextOffset = scanCompactionsRange(fd, startOffset, fileSize, acc);

    // Handle trailing line without newline for non-cached tail inspection without advancing offset past incomplete bytes
    const info = {
      exists: true,
      lineCount: acc.lineCount,
      maxStepIndex: Math.max(acc.maxStepIndex, maxStepIndex),
      goal: goal || (canResume ? cacheEntry.info?.goal || '' : ''),
      lastModel,
      lastUpdatedAt,
      lastStatus,
      lastError,
      compactions: acc.compactions,
    };

    const nextCacheEntry = {
      size: fileSize,
      mtimeMs,
      headHash,
      offset: nextOffset,
      acc,
      info,
      updatedAt: Date.now(),
    };
    return { info, nextCacheEntry };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

export function inspectById(convId, { env = process.env, hintPath = '', cacheMap = null } = {}) {
  if (!convId || !isValidConvIdOrPrefix(convId)) return null;
  const res = resolveBrainTranscript(convId, { env, hintPath });
  if (res.status !== 'ok') {
    return { exists: false, conversationId: convId, status: res.status };
  }
  const prevCache = cacheMap ? cacheMap[res.path] || null : null;
  const { info, nextCacheEntry } = inspectTranscript(res.path, { cacheEntry: prevCache });
  if (cacheMap && nextCacheEntry) {
    cacheMap[res.path] = nextCacheEntry;
  }
  return { conversationId: res.conversationId, ...info };
}

function pruneMapLru(obj, maxEntries = STATE_MAX_ENTRIES) {
  if (!obj || typeof obj !== 'object') return {};
  const entries = Object.entries(obj);
  if (entries.length <= maxEntries) return obj;
  entries.sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
  return Object.fromEntries(entries.slice(0, maxEntries));
}

export function loadPluginState(dataDir) {
  const filePath = join(dataDir, 'state.json');
  const raw = readJsonSafe(filePath, null);
  if (!raw || typeof raw !== 'object') {
    return { controllers: {}, transcriptCache: {} };
  }
  return {
    controllers: raw.controllers && typeof raw.controllers === 'object' ? raw.controllers : {},
    transcriptCache:
      raw.transcriptCache && typeof raw.transcriptCache === 'object' ? raw.transcriptCache : {},
  };
}

export function savePluginState(dataDir, state) {
  const normalized = {
    controllers: pruneMapLru(state?.controllers, STATE_MAX_ENTRIES),
    transcriptCache: pruneMapLru(state?.transcriptCache, STATE_MAX_ENTRIES),
  };
  atomicWriteText(join(dataDir, 'state.json'), `${JSON.stringify(normalized, null, 2)}\n`);
}
