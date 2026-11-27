import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  atomicWriteText,
  isInsideDir,
  readJsonSafe,
  resolveAppDataDirs,
  sha256,
  withFileLockSync,
} from './paths.mjs';

const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 64 * 1024;
const SWARM_BOARD_TAIL_BYTES = 32 * 1024;
const CHUNK_BYTES = 64 * 1024;
const STATE_MAX_ENTRIES = 200;
const ATTENTION_MAX_ENTRIES = 20;
const COMPACTION_ACC_VERSION = 2;

export const HEX_CONV_ID_RE =
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f-]{0,28})$/i;

const FULL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HEX_CANDIDATE_GLOBAL_RE =
  /(?<![A-Za-z0-9_-])([0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|-[0-9a-f-]{1,27}|[0-9a-f]{0,24}))(?![A-Za-z0-9_-])/gi;

export function isValidConvIdOrPrefix(token) {
  if (typeof token !== 'string') return false;
  const trimmed = token.trim();
  if (!HEX_CONV_ID_RE.test(trimmed)) return false;
  const hexOnly = trimmed.replace(/-/g, '');
  return hexOnly.length >= 8 && hexOnly.length <= 32;
}

function matchesKnownId(cand, knownList) {
  if (!Array.isArray(knownList) || knownList.length === 0) return false;
  const cLower = cand.toLowerCase();
  for (const k of knownList) {
    if (k === cLower) return true;
    if (cLower.length >= 8 && k.length >= 8 && (k.startsWith(cLower) || cLower.startsWith(k))) {
      return true;
    }
  }
  return false;
}

export function stripSystemMessageEnvelope(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw.trim();
  const sysMatch = text.match(/<SYSTEM_MESSAGE>([\s\S]*?)<\/SYSTEM_MESSAGE>/i);
  if (sysMatch) {
    text = sysMatch[1].trim();
  }
  text = text.replace(/^\[Message\]\s+timestamp=\S+\s+sender=\S+\s+priority=\S+\s+content=/i, '');
  return text.trim();
}

/**
 * Extract conversation IDs or 8+ hex prefixes from bare ID, short command, or structured report prompts.
 * In long inputs (> 400 chars), filters out incidental commit SHAs by requiring a full UUID or known registry ID prefix.
 */
export function extractPromptSessionIds(
  rawInput,
  { maxCandidates = 6, maxInputLength = 2000, knownIds = [] } = {}
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
  if (trimmed.length > Math.max((Number(maxInputLength) || 2000) * 4, 65536)) {
    return { isSingleBareId: false, ids: [] };
  }

  const stripped = trimmed
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .trim();

  if (!stripped || stripped.length > maxInputLength) {
    return { isSingleBareId: false, ids: [] };
  }

  const isLongText = stripped.length > 400;
  const normalizedKnown = Array.isArray(knownIds)
    ? knownIds.map((x) => String(x || '').trim().toLowerCase()).filter((x) => x.length >= 8)
    : [];

  const ids = [];
  const seen = new Set();
  for (const m of stripped.matchAll(HEX_CANDIDATE_GLOBAL_RE)) {
    const cand = m[1];
    if (!isValidConvIdOrPrefix(cand)) continue;
    if (isLongText && !FULL_UUID_RE.test(cand) && !matchesKnownId(cand, normalizedKnown)) {
      continue;
    }
    const key = cand.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(cand);
    if (ids.length >= maxCandidates) break;
  }

  return { isSingleBareId: false, ids };
}

const BRAIN_ENTRIES_TTL_MS = 2000;
const brainEntriesCache = new Map();

function listBrainDirEntriesCached(brainReal) {
  const now = Date.now();
  const hit = brainEntriesCache.get(brainReal);
  if (hit && now < hit.expiresAt) {
    return hit.entries;
  }
  const entries = readdirSync(brainReal, { withFileTypes: true });
  if (brainEntriesCache.size > 16) {
    brainEntriesCache.clear();
  }
  brainEntriesCache.set(brainReal, { expiresAt: now + BRAIN_ENTRIES_TTL_MS, entries });
  return entries;
}

export function resolveBrainTranscript(idOrPrefix, { env = process.env, hintPath = '' } = {}) {
  const cand = typeof idOrPrefix === 'string' ? idOrPrefix.trim() : '';
  if (!isValidConvIdOrPrefix(cand)) {
    return { status: 'invalid', conversationId: '', path: null, matches: [] };
  }
  const candLower = cand.toLowerCase();
  const appDirs = resolveAppDataDirs({ env, hintPath });

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
          return {
            status: 'ok',
            conversationId: cand,
            path: exactReal,
            matches: [cand],
          };
        }
      } catch {
        // ignore unreadable
      }
    }

    let entries = [];
    try {
      entries = listBrainDirEntriesCached(brainReal);
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

function resetCompactionWatermarks(acc, kind, modelKey, usedTokens) {
  acc.prevUsedByModel =
    kind === 'token_drop' && modelKey && usedTokens > 0 ? { [modelKey]: usedTokens } : {};
}

function recordCompactionEvent(acc, kind, { modelKey = '', usedTokens = 0 } = {}) {
  const line = acc.lineCount;
  // Deduplicate an explicit compaction event immediately followed within 2 lines by a token drop (or vice versa)
  if (
    acc.lastCompactionLine > 0 &&
    line - acc.lastCompactionLine <= 2 &&
    acc.lastCompactionKind !== kind
  ) {
    acc.lastCompactionLine = line;
    acc.lastCompactionKind = kind;
    resetCompactionWatermarks(acc, kind, modelKey, usedTokens);
    return;
  }
  acc.compactions += 1;
  acc.lastCompactionLine = line;
  acc.lastCompactionKind = kind;
  resetCompactionWatermarks(acc, kind, modelKey, usedTokens);
}

function processStepForCompactions(step, acc) {
  acc.lineCount += 1;
  const stype = String(step.type || '').toUpperCase();
  if (stype) {
    acc.lastStepType = stype;
  }
  if (Number.isInteger(step.step_index) && step.step_index > acc.maxStepIndex) {
    acc.maxStepIndex = step.step_index;
  }
  if (typeof step.model === 'string' && step.model.trim()) {
    acc.lastModel = step.model.trim();
  }
  if (typeof step.created_at === 'string' && step.created_at.trim()) {
    acc.lastUpdatedAt = step.created_at.trim();
  }
  const stepStatus = typeof step.status === 'string' ? step.status.trim() : '';
  if (stepStatus) {
    acc.lastStatus = stepStatus;
  }
  const hasStepError = typeof step.error === 'string' && Boolean(step.error.trim());
  if (!hasStepError && stepStatus.toUpperCase() !== 'ERROR') {
    acc.lastError = '';
    acc.lastErrorStep = 0;
  }
  if (hasStepError) {
    acc.lastError = step.error.trim().slice(0, 120);
    acc.lastErrorStep = Number.isInteger(step.step_index) ? step.step_index : acc.lineCount;
  }
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
          recordCompactionEvent(acc, 'token_drop', { modelKey: mkey, usedTokens: used });
        }
        acc.prevUsedByModel[mkey] = used;
      }
    }
  }
}

function scanCompactionsRange(fd, startOffset, endOffset, seedAcc) {
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  let pos = startOffset;
  let leftoverBuf = Buffer.alloc(0);
  let lastCompleteOffset = startOffset;

  while (pos < endOffset) {
    const toRead = Math.min(CHUNK_BYTES, endOffset - pos);
    const n = readSync(fd, buf, 0, toRead, pos);
    if (n <= 0) break;

    const combined =
      leftoverBuf.length > 0
        ? Buffer.concat([leftoverBuf, buf.subarray(0, n)])
        : Buffer.from(buf.subarray(0, n));
    const lastNl = combined.lastIndexOf(0x0a);

    if (lastNl >= 0) {
      const completeSlice = combined.subarray(0, lastNl);
      leftoverBuf = combined.subarray(lastNl + 1);
      lastCompleteOffset = pos + n - leftoverBuf.length;

      const text = completeSlice.toString('utf8');
      for (const rawLine of text.split('\n')) {
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
    } else {
      leftoverBuf = combined;
    }
    pos += n;
  }

  // Evaluate trailing JSON line lacking a final newline on a cloned accumulator so cached offset never double-counts
  let viewAcc = seedAcc;
  if (leftoverBuf.length > 0) {
    const tailStr = leftoverBuf.toString('utf8').trim();
    if (tailStr) {
      try {
        const step = JSON.parse(tailStr);
        if (step && typeof step === 'object') {
          viewAcc = {
            ...seedAcc,
            prevUsedByModel: { ...(seedAcc.prevUsedByModel || {}) },
          };
          processStepForCompactions(step, viewAcc);
        }
      } catch {
        // incomplete trailing JSON line
      }
    }
  }

  return { lastCompleteOffset, viewAcc };
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
      lastStepType: '',
      lastError: '',
      lastErrorStep: 0,
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
    cacheEntry.accVersion === COMPACTION_ACC_VERSION &&
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

    // 1) Probe first 512 bytes for headHash and skip full 32KB head scan on valid incremental cache hit
    const probeLen = Math.min(512, fileSize);
    const probeBuf = readRangeSync(fd, 0, probeLen);
    const headHash = sha256(probeBuf);

    const canResumeHead =
      cacheEntry &&
      cacheEntry.accVersion === COMPACTION_ACC_VERSION &&
      cacheEntry.headHash === headHash &&
      Number.isInteger(cacheEntry.offset) &&
      cacheEntry.offset >= 0 &&
      cacheEntry.offset <= fileSize &&
      cacheEntry.acc;

    let goal = canResumeHead && typeof cacheEntry.info?.goal === 'string' ? cacheEntry.info.goal : '';
    if (!canResumeHead || (!goal && !cacheEntry.headScanned)) {
      const headLen = Math.min(HEAD_BYTES, fileSize);
      const headBuf =
        headLen <= probeLen
          ? probeBuf
          : Buffer.concat([probeBuf, readRangeSync(fd, probeLen, headLen - probeLen)]);
      const headText = headBuf.toString('utf8');
      const headLines = fileSize > headLen ? headText.split('\n').slice(0, -1) : headText.split('\n');
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
    }

    // 2) Read tail up to 64KB for latest status, model, timestamp, error
    const tailOffset = Math.max(0, fileSize - TAIL_BYTES);
    const tailBuf = readRangeSync(fd, tailOffset, fileSize - tailOffset);
    const tailText = tailBuf.toString('utf8');
    const tailLines = tailOffset > 0 ? tailText.split('\n').slice(1) : tailText.split('\n');

    let lastModel = '';
    let lastUpdatedAt = '';
    let lastStatus = '';
    let lastStepType = '';
    let lastError = '';
    let lastErrorStep = 0;
    let maxStepIndex = 0;
    let sawTailStep = false;

    for (const rawLine of tailLines) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const step = JSON.parse(line);
        if (!step || typeof step !== 'object') continue;
        sawTailStep = true;
        const stype = String(step.type || '').trim().toUpperCase();
        if (stype) lastStepType = stype;
        if (Number.isInteger(step.step_index) && step.step_index > maxStepIndex) {
          maxStepIndex = step.step_index;
        }
        if (typeof step.model === 'string' && step.model.trim()) {
          lastModel = step.model.trim();
        }
        if (typeof step.created_at === 'string' && step.created_at.trim()) {
          lastUpdatedAt = step.created_at.trim();
        }
        const stepStatus = typeof step.status === 'string' ? step.status.trim() : '';
        if (stepStatus) {
          lastStatus = stepStatus;
        }
        const hasStepError = typeof step.error === 'string' && Boolean(step.error.trim());
        if (!hasStepError && stepStatus.toUpperCase() !== 'ERROR') {
          lastError = '';
          lastErrorStep = 0;
        }
        if (hasStepError) {
          lastError = step.error.trim().slice(0, 120);
          lastErrorStep = Number.isInteger(step.step_index) ? step.step_index : maxStepIndex;
        }
      } catch {
        // skip partial tail line
      }
    }

    // 3) Incremental compaction scan from cached byte offset (or 0)
    const canResume = Boolean(canResumeHead);

    const acc = canResume
      ? {
          lineCount: cacheEntry.acc.lineCount || 0,
          maxStepIndex: Math.max(cacheEntry.acc.maxStepIndex || 0, maxStepIndex),
          compactions: cacheEntry.acc.compactions || 0,
          lastCompactionLine: cacheEntry.acc.lastCompactionLine || 0,
          lastCompactionKind: cacheEntry.acc.lastCompactionKind || '',
          lastModel: cacheEntry.acc.lastModel || cacheEntry.info?.lastModel || '',
          lastUpdatedAt: cacheEntry.acc.lastUpdatedAt || cacheEntry.info?.lastUpdatedAt || '',
          lastStatus: cacheEntry.acc.lastStatus || cacheEntry.info?.lastStatus || '',
          lastStepType: cacheEntry.acc.lastStepType || cacheEntry.info?.lastStepType || '',
          lastError: cacheEntry.acc.lastError ?? cacheEntry.info?.lastError ?? '',
          lastErrorStep: cacheEntry.acc.lastErrorStep || cacheEntry.info?.lastErrorStep || 0,
          prevUsedByModel: { ...(cacheEntry.acc.prevUsedByModel || {}) },
        }
      : {
          lineCount: 0,
          maxStepIndex,
          compactions: 0,
          lastCompactionLine: 0,
          lastCompactionKind: '',
          lastModel: '',
          lastUpdatedAt: '',
          lastStatus: '',
          lastStepType: '',
          lastError: '',
          lastErrorStep: 0,
          prevUsedByModel: {},
        };

    const startOffset = canResume ? cacheEntry.offset : 0;
    const { lastCompleteOffset: nextOffset, viewAcc } = scanCompactionsRange(fd, startOffset, fileSize, acc);

    const resolvedError = sawTailStep ? lastError : viewAcc.lastError || '';
    const resolvedErrorStep = sawTailStep ? lastErrorStep : viewAcc.lastErrorStep || 0;

    const info = {
      exists: true,
      lineCount: viewAcc.lineCount,
      maxStepIndex: Math.max(viewAcc.maxStepIndex, maxStepIndex),
      goal: goal || (canResume ? cacheEntry.info?.goal || '' : ''),
      lastModel: lastModel || viewAcc.lastModel || '',
      lastUpdatedAt: lastUpdatedAt || viewAcc.lastUpdatedAt || '',
      lastStatus: lastStatus || viewAcc.lastStatus || '',
      lastStepType: lastStepType || viewAcc.lastStepType || '',
      lastError: resolvedError,
      lastErrorStep: resolvedError ? resolvedErrorStep : 0,
      compactions: viewAcc.compactions,
    };

    const nextCacheEntry = {
      accVersion: COMPACTION_ACC_VERSION,
      size: fileSize,
      mtimeMs,
      headHash,
      headScanned: true,
      offset: nextOffset,
      acc,
      info,
      updatedAt: Date.now(),
    };
    return { info, nextCacheEntry };
  } catch {
    return { info: emptyInfo, nextCacheEntry: null };
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

function readTailText(filePath, maxBytes) {
  if (!filePath || !existsSync(filePath)) return '';
  let fd;
  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.size === 0) return '';
    const offset = Math.max(0, st.size - maxBytes);
    fd = openSync(filePath, 'r');
    const buf = readRangeSync(fd, offset, st.size - offset);
    const raw = buf.toString('utf8');
    if (offset > 0) {
      const nl = raw.indexOf('\n');
      return nl >= 0 ? raw.slice(nl + 1) : '';
    }
    return raw;
  } catch {
    return '';
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

export function hasOutboundAgentApiReport(tp, recipientId) {
  if (!tp || !recipientId || !existsSync(tp)) return false;
  const tailText = readTailText(tp, TAIL_BYTES);
  if (!tailText) return false;
  const lines = tailText.split('\n').filter((l) => l.trim());
  let lastTurnStart = 0;
  const steps = [];
  for (const line of lines) {
    try {
      const step = JSON.parse(line);
      if (step && typeof step === 'object') {
        if (String(step.type || '').toUpperCase() === 'USER_INPUT') {
          lastTurnStart = steps.length;
        }
        steps.push(step);
      }
    } catch {
      // ignore partial line
    }
  }
  const targetFull = String(recipientId).trim().toLowerCase();
  const targetPrefix = targetFull.slice(0, 8);
  for (let i = lastTurnStart; i < steps.length; i += 1) {
    const step = steps[i];
    const stype = String(step.type || '').toUpperCase();
    if (stype === 'USER_INPUT') continue;
    const tcs = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    for (const tc of tcs) {
      const tcName = String(tc?.name || tc?.function?.name || '').trim();
      const tcNameLower = tcName.toLowerCase();
      const isCmdTool =
        tcNameLower === 'run_command' ||
        tcNameLower === 'bash' ||
        tcNameLower === 'execute_command' ||
        tcNameLower === 'shell';
      if (tcName !== 'send_message' && !isCmdTool) continue;
      const tcBlob = JSON.stringify(tc?.args ?? tc?.function?.arguments ?? '').toLowerCase();
      const hasRecipient =
        tcBlob.includes(targetFull) || (targetPrefix.length >= 8 && tcBlob.includes(targetPrefix));
      if (!hasRecipient) continue;
      if (tcName !== 'send_message' && !tcBlob.includes('send-message')) continue;

      const tcId = String(tc?.id || tc?.tool_call_id || '').trim();
      let callFailed = false;
      for (let j = i + 1; j < steps.length; j += 1) {
        const nextStep = steps[j];
        const nextType = String(nextStep?.type || '').toUpperCase();
        if (nextType === 'USER_INPUT') break;
        const matchesId =
          tcId &&
          (nextStep?.tool_call_id === tcId ||
            (Array.isArray(nextStep?.tool_results) &&
              nextStep.tool_results.some((tr) => tr?.tool_call_id === tcId && (tr?.status === 'ERROR' || tr?.error))));
        const isImmediateErr =
          !tcId &&
          j === i + 1 &&
          (String(nextStep?.status || '').toUpperCase() === 'ERROR' || Boolean(nextStep?.error));
        if (
          matchesId &&
          (String(nextStep?.status || '').toUpperCase() === 'ERROR' ||
            Boolean(nextStep?.error) ||
            (typeof nextStep?.content === 'string' &&
              (nextStep.content.includes('Command failed:') || nextStep.content.includes('ENOENT'))))
        ) {
          callFailed = true;
          break;
        }
        if (isImmediateErr) {
          callFailed = true;
          break;
        }
      }
      if (!callFailed) return true;
    }
  }
  return false;
}

export function inspectNativeSwarm(
  controllerConvId,
  { env = process.env, hintPath = '', cacheMap = null } = {}
) {
  const empty = { active: false, title: '', members: [], recentPosts: [] };
  if (!controllerConvId || !isValidConvIdOrPrefix(controllerConvId)) return empty;
  const appDirs = resolveAppDataDirs({ env, hintPath });
  const targetLower = controllerConvId.trim().toLowerCase();

  let swarmDir = '';
  for (const appDir of appDirs) {
    const brainDir = join(appDir, 'brain');
    if (!existsSync(brainDir)) continue;
    const exactSwarm = join(brainDir, controllerConvId.trim(), '.system_generated', 'swarm');
    if (existsSync(join(exactSwarm, 'members.json'))) {
      swarmDir = exactSwarm;
      break;
    }
    try {
      const brainReal = realpathSync(brainDir);
      for (const ent of listBrainDirEntriesCached(brainReal)) {
        if (!ent.isDirectory()) continue;
        if (!ent.name.toLowerCase().startsWith(targetLower)) continue;
        const cand = join(brainReal, ent.name, '.system_generated', 'swarm');
        if (existsSync(join(cand, 'members.json'))) {
          swarmDir = cand;
          break;
        }
      }
    } catch {
      // ignore unreadable brain dir
    }
    if (swarmDir) break;
  }

  if (!swarmDir) return empty;
  const membersData = readJsonSafe(join(swarmDir, 'members.json'), null);
  if (!membersData || typeof membersData !== 'object') return empty;

  const rawMembers = membersData.members && typeof membersData.members === 'object' ? membersData.members : {};
  const members = Object.entries(rawMembers).map(([name, meta]) => {
    const m = meta && typeof meta === 'object' ? meta : {};
    const cid = String(m.conversation_id || m.conversationId || '').trim();
    const isKilled = Boolean(m.killed);
    // Skip disk I/O on killed Swarm members to prevent O(N) PreInvocation slowness
    const tel = !isKilled && cid ? inspectById(cid, { env, hintPath, cacheMap }) : null;
    let role = String(m.role || '').trim().toLowerCase();
    if (!role) {
      if (/^narrator(-\d+)?$/i.test(name)) role = 'narrator';
      else if (/^monitor(-\d+)?$/i.test(name)) role = 'monitor';
      else if (/^coordinator$/i.test(name)) role = 'coordinator';
      else role = 'worker';
    }
    let state = 'waiting';
    if (isKilled) state = 'killed';
    else if (
      tel?.exists &&
      tel.lastStatus &&
      !['DONE', 'IDLE', 'WAITING', 'OK', 'COMPLETED'].includes(tel.lastStatus.toUpperCase())
    ) {
      state = 'working';
    }
    return {
      name,
      role,
      conversationId: cid,
      model: String(m.model || tel?.lastModel || '-'),
      workspace: String(m.workspace || 'inherit'),
      state,
      compactions: tel?.compactions || 0,
      steps: tel?.maxStepIndex || tel?.lineCount || 0,
      lastUpdatedAt: tel?.lastUpdatedAt || '',
      lastError: tel?.lastError || '',
    };
  });

  const boardTail = readTailText(join(swarmDir, 'board.jsonl'), SWARM_BOARD_TAIL_BYTES);
  const recentPosts = [];
  if (boardTail) {
    for (const rawLine of boardTail.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const post = JSON.parse(line);
        if (post && typeof post === 'object') {
          recentPosts.push({
            seq: Number(post.seq || 0),
            agent: String(post.agent || '-'),
            text: String(post.text || '').replace(/\s+/g, ' ').trim().slice(0, 140),
            time: String(post.time || ''),
          });
        }
      } catch {
        // ignore partial line
      }
    }
  }

  const hasLiveMembers = members.length === 0 || members.some((m) => m.state !== 'killed');
  return {
    active: hasLiveMembers,
    title: String(membersData.title || 'Native Swarm'),
    members,
    recentPosts: recentPosts.slice(-5),
  };
}

const SUBAGENT_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Inspect hidden execution surfaces (invoke_subagent & run_workflow) launched from
 * the active controller's recent transcript tail (bounded 64KB read, zero sidebar clutter).
 */
export function inspectHiddenSurfaces(
  controllerConvId,
  { env = process.env, hintPath = '', cacheMap = null } = {}
) {
  const empty = { subagents: [], workflows: [] };
  if (!controllerConvId || !isValidConvIdOrPrefix(controllerConvId)) return empty;
  const resolved = resolveBrainTranscript(controllerConvId, { env, hintPath });
  if (resolved.status !== 'ok' || !resolved.path) return empty;

  const tailText = readTailText(resolved.path, TAIL_BYTES);
  if (!tailText) return empty;

  const steps = [];
  for (const rawLine of tailText.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') steps.push(obj);
    } catch {
      // skip partial tail line
    }
  }

  const subagents = [];
  const workflows = [];
  const seenSub = new Set();

  const ctrlFullLower = String(resolved.conversationId || controllerConvId).toLowerCase();
  const ctrlInputLower = String(controllerConvId).toLowerCase();

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    const claimedResultIndices = new Set();
    for (const tc of toolCalls) {
      const name = String(tc?.name || tc?.function?.name || '').trim();
      let args = {};
      if (tc?.args && typeof tc.args === 'object') {
        args = tc.args;
      } else if (typeof tc?.function?.arguments === 'string') {
        try {
          args = JSON.parse(tc.function.arguments) || {};
        } catch {
          args = {};
        }
      }
      const tcId = String(tc?.id || tc?.tool_call_id || '').trim();

      if (name === 'invoke_subagent') {
        let childId = '';
        let resultStatus = 'RUNNING';
        for (let j = i + 1; j < Math.min(steps.length, i + 1 + toolCalls.length + 6); j += 1) {
          const next = steps[j];
          if (String(next.type || '').toUpperCase() === 'PLANNER_RESPONSE') break;
          if (claimedResultIndices.has(j)) continue;
          const nextTcId = String(next.tool_call_id || '').trim();
          if (tcId && nextTcId && tcId !== nextTcId) continue;
          const content = String(next.content || '');
          const m = content.match(SUBAGENT_ID_RE);
          if (m) {
            const hitLower = m[0].toLowerCase();
            if (hitLower !== ctrlFullLower && !hitLower.startsWith(ctrlInputLower)) {
              childId = m[0];
              resultStatus = String(next.status || 'DONE').toUpperCase();
              claimedResultIndices.add(j);
              break;
            }
          }
        }
        const dedup =
          childId || `${args.Role || args.TypeName || 'sub'}-${step.step_index || i}-${subagents.length}`;
        if (seenSub.has(dedup)) continue;
        seenSub.add(dedup);

        const tel = childId ? inspectById(childId, { env, hintPath, cacheMap }) : null;
        subagents.push({
          role: String(args.Role || args.TypeName || 'Subagent').slice(0, 60),
          typeName: String(args.TypeName || 'self'),
          model: String(args.Model || tel?.lastModel || 'inherit'),
          workspace: String(args.Workspace || 'inherit'),
          conversationId: childId,
          status: tel?.exists ? tel.lastStatus || resultStatus : resultStatus,
          steps: tel?.maxStepIndex || tel?.lineCount || 0,
          compactions: tel?.compactions || 0,
          lastUpdatedAt: tel?.lastUpdatedAt || String(step.created_at || ''),
          lastError: tel?.lastError || '',
          telemetry: tel,
        });
      } else if (name === 'run_workflow') {
        let wfStatus = String(step.status || 'DONE').toUpperCase();
        if (i + 1 < steps.length && String(steps[i + 1].type || '').toUpperCase() === 'GENERIC') {
          wfStatus = String(steps[i + 1].status || wfStatus).toUpperCase();
        }
        workflows.push({
          description: String(args.Description || 'Dynamic Workflow').slice(0, 100),
          scriptPath: String(args.ScriptPath || '').split('/').pop() || 'inline',
          status: wfStatus,
          stepIndex: Number(step.step_index || i),
          createdAt: String(step.created_at || ''),
        });
      }
    }
  }

  return {
    subagents: subagents.slice(-8).reverse(),
    workflows: workflows.slice(-6).reverse(),
  };
}

export function extractFirstUserPromptRaw(tp, maxChars = 4000) {
  if (!tp || !existsSync(tp)) return '';
  let fd;
  try {
    const st = statSync(tp);
    if (!st.isFile() || st.size === 0) return '';
    fd = openSync(tp, 'r');
    const maxScan = Math.min(st.size, 256 * 1024);
    let pos = 0;
    let leftoverBuf = Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);

    while (pos < maxScan) {
      const toRead = Math.min(CHUNK_BYTES, maxScan - pos);
      const n = readSync(fd, buf, 0, toRead, pos);
      if (n <= 0) break;
      const combined =
        leftoverBuf.length > 0
          ? Buffer.concat([leftoverBuf, buf.subarray(0, n)])
          : Buffer.from(buf.subarray(0, n));
      const lastNl = combined.lastIndexOf(0x0a);
      const sliceToParse =
        lastNl >= 0 ? combined.subarray(0, lastNl) : pos + n >= st.size ? combined : null;
      leftoverBuf = lastNl >= 0 ? combined.subarray(lastNl + 1) : combined;
      pos += n;

      if (!sliceToParse) continue;
      for (const rawLine of sliceToParse.toString('utf8').split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const step = JSON.parse(line);
          if (step && typeof step === 'object' && String(step.type || '').toUpperCase() === 'USER_INPUT') {
            const content = String(step.content || '').trim();
            if (content) return content.slice(0, maxChars);
          }
        } catch {
          // skip malformed line
        }
      }
    }
    return '';
  } catch {
    return '';
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

function pruneMapLru(obj, maxEntries = STATE_MAX_ENTRIES) {
  if (!obj || typeof obj !== 'object') return {};
  const entries = Object.entries(obj);
  if (entries.length <= maxEntries) return obj;
  entries.sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
  return Object.fromEntries(entries.slice(0, maxEntries));
}

function pruneAttentionList(list, maxEntries = ATTENTION_MAX_ENTRIES) {
  if (!Array.isArray(list)) return [];
  const filtered = list.filter((x) => x && typeof x === 'object' && x.id);
  if (filtered.length <= maxEntries) return filtered;
  return filtered.slice(-maxEntries);
}

function prunePendingSuccessors(obj, nowMs = Date.now(), ttlMs = 2 * 3600 * 1000) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!v || typeof v !== 'object' || !v.convId) continue;
    const age = Math.max(0, nowMs - (Number(v.createdAt || 0) || 0));
    if (age <= ttlMs) {
      const item = { convId: String(v.convId), createdAt: Number(v.createdAt || nowMs) };
      if (v.activatedAt) {
        if (nowMs - Number(v.activatedAt) > 60 * 1000) continue;
        item.activatedAt = Number(v.activatedAt);
      }
      out[k] = item;
    }
  }
  return out;
}

export function loadPluginState(dataDir) {
  const filePath = join(dataDir, 'state.json');
  const raw = readJsonSafe(filePath, null);
  if (!raw || typeof raw !== 'object') {
    return {
      controllers: {},
      workers: {},
      pendingAttention: [],
      pendingSuccessors: {},
      transcriptCache: {},
    };
  }
  return {
    controllers: raw.controllers && typeof raw.controllers === 'object' ? raw.controllers : {},
    workers: raw.workers && typeof raw.workers === 'object' ? raw.workers : {},
    pendingAttention: pruneAttentionList(raw.pendingAttention),
    pendingSuccessors: prunePendingSuccessors(raw.pendingSuccessors),
    transcriptCache:
      raw.transcriptCache && typeof raw.transcriptCache === 'object' ? raw.transcriptCache : {},
  };
}

export function savePluginState(dataDir, state) {
  const nowMs = Date.now();
  const prunedAtt = pruneAttentionList(state?.pendingAttention, ATTENTION_MAX_ENTRIES).filter((x) => {
    const age = Math.max(0, nowMs - (Number(x.updatedAt || 0) || 0));
    return age <= 24 * 3600 * 1000;
  });
  const normalized = {
    controllers: pruneMapLru(state?.controllers, STATE_MAX_ENTRIES),
    workers: pruneMapLru(state?.workers, STATE_MAX_ENTRIES),
    pendingAttention: prunedAtt,
    pendingSuccessors: prunePendingSuccessors(state?.pendingSuccessors, nowMs),
    transcriptCache: pruneMapLru(state?.transcriptCache, STATE_MAX_ENTRIES),
  };
  atomicWriteText(join(dataDir, 'state.json'), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

export function updatePluginState(dataDir, mutator) {
  if (!dataDir) {
    const dummy = loadPluginState('');
    mutator(dummy);
    return dummy;
  }
  return withFileLockSync(join(dataDir, '.state.lock'), () => {
    const latest = loadPluginState(dataDir);
    const shouldSave = mutator(latest);
    if (shouldSave === false) return latest;
    return savePluginState(dataDir, latest);
  });
}
