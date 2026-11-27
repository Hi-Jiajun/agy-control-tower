import { existsSync, readFileSync } from 'node:fs';
import { PathError } from './paths.mjs';

const CONV_LINK_RE = /conversation:\/\/([A-Za-z0-9][A-Za-z0-9_-]{3,127})/;
const BACKTICK_RE = /`([^`\n]+)`/g;
const PLACEHOLDER_RE = /^(\[.*\]|<.*>|暂无|-+|NONE|IDLE|ONLINE|OFFLINE|STANDBY|HANDOVER|RETIRED|PENDING|ACTIVE|DONE)$/i;

export function extractConvId(cell) {
  if (!cell || typeof cell !== 'string') return '';
  const m = cell.match(CONV_LINK_RE);
  if (m) return m[1].trim();
  for (const hit of cell.matchAll(BACKTICK_RE)) {
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

export function splitMdRow(line) {
  const s = (line || '').trim();
  if (!s.startsWith('|') || !s.endsWith('|')) return null;
  return s
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, '|').trim());
}

function sameSessionId(idA, idB) {
  const a = String(idA || '').trim().toLowerCase();
  const b = String(idB || '').trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 8 && b.length >= 8 && /^[0-9a-f-]+$/.test(a) && /^[0-9a-f-]+$/.test(b)) {
    return a.startsWith(b) || b.startsWith(a);
  }
  return false;
}

export function isSeparatorRow(cells) {
  return Array.isArray(cells) && cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s+/g, '')));
}

export function stripMd(text) {
  let s = String(text ?? '').trim();
  if (s.startsWith('**') && s.endsWith('**') && s.length > 4) {
    s = s.slice(2, -2).trim();
  }
  if (s.startsWith('`') && s.endsWith('`') && s.length > 2) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function cleanMdVal(text) {
  let s = String(text ?? '').trim();
  if (s.startsWith('**') && s.endsWith('**') && s.length > 4) s = s.slice(2, -2).trim();
  if (s.startsWith('`') && s.endsWith('`') && s.length > 2) s = s.slice(1, -1).trim();
  return s.replace(/`/g, '').trim();
}

export function sanitizeCell(val, { backtick = false } = {}) {
  const clean = String(val ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '/').trim() || '-';
  if (!backtick) return clean;
  const inner = clean.replace(/^`+|`+$/g, '').replace(/`/g, '').trim() || '-';
  return `\`${inner}\``;
}

function formatConvCell(conversationId) {
  const cleanId = sanitizeCell(conversationId, { backtick: false });
  if (!cleanId || cleanId === '-' || cleanId === '暂无') return '`暂无`';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{3,127}$/.test(cleanId)) {
    return sanitizeCell(cleanId, { backtick: true });
  }
  const shortLabel = cleanId.length > 8 ? cleanId.slice(0, 8) : cleanId;
  return `[\`${shortLabel}\`](conversation://${cleanId})`;
}

export function parseRegistry(mdText) {
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

  for (const rawLine of String(mdText ?? '').split(/\r?\n/)) {
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
        const mainSeg = line
          .replace(/^.*?当前现役总控会话(?:\*\*)?[：:]\s*/, '')
          .split(/[（(]\s*状态/)[0];
        result.controller.currentControllerId = extractConvId(mainSeg);
        const stM = line.match(/状态[：:]\s*`?([A-Za-z0-9_-]+)`?/);
        if (stM) result.controller.currentControllerStatus = stM[1];
      } else if (line.includes('常驻模型配置')) {
        result.controller.defaultModel = cleanMdVal(
          line.replace(/^-\s*\*\*常驻模型配置\*\*[：:]\s*/, '').trim()
        );
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
      tableHeader = cells.map(cleanMdVal);
      inTable = true;
      continue;
    }
    if (isSeparatorRow(cells)) continue;
    while (cells.length < tableHeader.length) cells.push('');

    if (section === 'lease' && cells.length >= 2) {
      const k = cleanMdVal(cells[0]);
      const v = cleanMdVal(cells[1]);
      if (k.includes('锁状态')) result.lease.lockStatus = v;
      else if (k.includes('持锁会话')) result.lease.holder = v;
      else if (k.includes('独占对象')) result.lease.resource = v;
      else if (k.includes('起始时间')) result.lease.since = v;
      else if (k.includes('操作范围') || k.includes('保护现场')) result.lease.scope = v;
      else if (k.includes('解锁判据')) result.lease.releaseCriteria = v;
    } else if (section === 'controller' && subsection.includes('换届历史') && cells.length >= 5) {
      result.controller.handoverHistory.push({
        term: cleanMdVal(cells[0]),
        conversationId: extractConvId(cells[1]) || cleanMdVal(cells[1]),
        model: cleanMdVal(cells[2]),
        period: cleanMdVal(cells[3]),
        summary: cleanMdVal(cells[4]),
      });
    } else if (section === 'active' && cells.length >= 6) {
      const first = cleanMdVal(cells[0]);
      if (!first || first === '暂无' || first === '-') continue;
      result.activeSessions.push({
        rawCell: cells[0],
        conversationId: extractConvId(cells[0]),
        topic: cleanMdVal(cells[1]),
        modelTool: cleanMdVal(cells[2]),
        lockStatus: cleanMdVal(cells[3]),
        status: cleanMdVal(cells[4]),
        paths: cleanMdVal(cells[5]),
      });
    } else if (section === 'archived' && cells.length >= 3) {
      const first = cleanMdVal(cells[0]);
      if (!first || first === '暂无' || first === '-') continue;
      result.archivedSessions.push({
        rawCell: cells[0],
        conversationId: extractConvId(cells[0]),
        milestone: cleanMdVal(cells[1]),
        summary: cleanMdVal(cells[2]),
      });
    } else if (section === 'queue' && cells.length >= 4) {
      const first = cleanMdVal(cells[0]);
      if (!first || first === '暂无' || first === '-' || PLACEHOLDER_RE.test(first)) continue;
      result.queue.push({
        id: first,
        summary: cleanMdVal(cells[1]),
        status: cleanMdVal(cells[2]),
        route: cleanMdVal(cells[3]),
      });
    }
  }

  return result;
}

export function isActiveController(convId, parsed) {
  if (!convId || !parsed) return false;
  const ctrlId = ((parsed.controller || {}).currentControllerId || '').trim();
  if (!ctrlId || PLACEHOLDER_RE.test(ctrlId)) return false;
  if (convId.toLowerCase() === ctrlId.toLowerCase()) return true;
  if (convId.length >= 8 && ctrlId.length >= 8) {
    const a = convId.toLowerCase();
    const b = ctrlId.toLowerCase();
    return b.startsWith(a) || a.startsWith(b);
  }
  return false;
}

export function findActiveWorkerSession(convId, parsed) {
  if (!convId || !parsed || !Array.isArray(parsed.activeSessions)) return null;
  const a = String(convId).trim().toLowerCase();
  if (!a) return null;
  for (const row of parsed.activeSessions) {
    const b = String(row?.conversationId || '').trim().toLowerCase();
    if (!b || PLACEHOLDER_RE.test(b)) continue;
    if (a === b || (a.length >= 8 && b.length >= 8 && (a.startsWith(b) || b.startsWith(a)))) {
      return row;
    }
  }
  return null;
}

function findSectionRange(lines, headingMatcher, labelForErr) {
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (start < 0) {
      if (t.startsWith('## ') && headingMatcher(t)) {
        start = i;
      }
    } else if (t.startsWith('## ')) {
      end = i;
      break;
    }
  }
  if (start < 0) {
    throw new PathError(400, `Current SESSION-REGISTRY.md has no ${labelForErr}`);
  }
  return { start, end };
}

function findTableBoundsInRange(lines, start, end, labelForErr) {
  let sepIdx = -1;
  let tableEnd = end;
  for (let i = start + 1; i < end; i += 1) {
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
    throw new PathError(400, `Malformed ${labelForErr} table`);
  }
  return { sepIdx, tableEnd };
}

export function updateLeaseSection(mdText, patch) {
  const lines = String(mdText ?? '').split(/\r?\n/);
  const { start, end } = findSectionRange(
    lines,
    (t) => t.includes('独占资源租约') || t.includes('Exclusive Resource Lease'),
    'Section 1 Exclusive Resource Lease'
  );

  let updated = false;
  for (let i = start + 1; i < end; i += 1) {
    const cells = splitMdRow(lines[i]);
    if (!cells || cells.length < 2 || isSeparatorRow(cells)) continue;
    const key = cleanMdVal(cells[0]);
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
    throw new PathError(400, 'No lease fields matched in Section 1');
  }
  return lines.join('\n');
}

export function updateControllerSection(
  mdText,
  { controllerId, status = 'ONLINE', defaultModel, appendHistory = false, period = '', summary = '' } = {}
) {
  const cleanId = sanitizeCell(controllerId, { backtick: false });
  if (!cleanId || cleanId === '-' || cleanId === '暂无') {
    throw new PathError(400, 'controllerId is required');
  }
  const cleanStatus = sanitizeCell(status || 'ONLINE', { backtick: false });
  const lines = String(mdText ?? '').split(/\r?\n/);
  const { start, end } = findSectionRange(
    lines,
    (t) => t.includes('常驻主交流总控') || t.includes('Control Tower'),
    'Section 2 Control Tower'
  );

  let updatedLine = false;
  let modelLineUpdated = false;
  let historySubStart = -1;

  for (let i = start + 1; i < end; i += 1) {
    const t = lines[i].trim();
    if (t.startsWith('- ') && t.includes('当前现役总控会话')) {
      lines[i] = `- **当前现役总控会话**：\`${cleanId}\`（状态：\`${cleanStatus}\`）`;
      updatedLine = true;
    } else if (t.startsWith('- ') && t.includes('常驻模型配置') && defaultModel !== undefined && String(defaultModel).trim()) {
      lines[i] = `- **常驻模型配置**：${sanitizeCell(defaultModel)}`;
      modelLineUpdated = true;
    } else if (t.startsWith('### ') && t.includes('换届历史')) {
      historySubStart = i;
    }
  }

  if (!updatedLine) {
    lines.splice(start + 1, 0, `- **当前现役总控会话**：\`${cleanId}\`（状态：\`${cleanStatus}\`）`);
  }

  if (appendHistory && historySubStart >= 0) {
    const reRange = findSectionRange(
      lines,
      (t) => t.includes('常驻主交流总控') || t.includes('Control Tower'),
      'Section 2 Control Tower'
    );
    const subIdx = lines.findIndex((l, idx) => idx > reRange.start && idx < reRange.end && l.trim().startsWith('### ') && l.includes('换届历史'));
    if (subIdx >= 0) {
      const { sepIdx, tableEnd } = findTableBoundsInRange(lines, subIdx, reRange.end, 'Section 2 Handover History');
      const existingRows = [];
      for (let i = sepIdx + 1; i < tableEnd; i += 1) {
        const cells = splitMdRow(lines[i]);
        if (!cells) continue;
        const rawCid = extractConvId(cells[1]) || cleanMdVal(cells[1]);
        if (rawCid === '<首任总控 ID>' || rawCid === '暂无' || rawCid === '-') continue;
        existingRows.push(lines[i]);
      }
      const nextTerm = existingRows.length + 1;
      const modelStr = sanitizeCell(defaultModel || 'Gemini 4 Neon (High)');
      const periodStr = sanitizeCell(period || `${new Date().toISOString().slice(0, 10)} ~`);
      const summaryStr = sanitizeCell(summary || (nextTerm === 1 ? '首任常驻主交流总控' : '总控换届接班'));
      existingRows.push(`| \`${nextTerm}\` | \`${cleanId}\` | ${modelStr} | ${periodStr} | ${summaryStr} |`);
      lines.splice(sepIdx + 1, tableEnd - (sepIdx + 1), ...existingRows);
    }
  } else if (defaultModel && !modelLineUpdated) {
    // If defaultModel provided and line did not exist, insert below active controller line
    const idx = lines.findIndex((l) => l.includes('当前现役总控会话'));
    if (idx >= 0) {
      lines.splice(idx + 1, 0, `- **常驻模型配置**：${sanitizeCell(defaultModel)}`);
    }
  }

  return lines.join('\n');
}

export function upsertActiveSessionRow(
  mdText,
  { conversationId, topic, modelTool = '-', lockStatus = '纯离线无锁', status = 'ACTIVE', paths = '-' } = {}
) {
  const cleanId = sanitizeCell(conversationId, { backtick: false });
  if (!cleanId || cleanId === '-' || cleanId === '暂无') {
    throw new PathError(400, 'conversationId is required');
  }
  const lines = String(mdText ?? '').split(/\r?\n/);
  const { start, end } = findSectionRange(
    lines,
    (t) => t.includes('活跃') || t.includes('挂起'),
    'Section 3 Active Sessions'
  );
  const { sepIdx, tableEnd } = findTableBoundsInRange(lines, start, end, 'Section 3 Active Sessions');

  const newRow = `| ${formatConvCell(cleanId)} | ${sanitizeCell(topic)} | ${sanitizeCell(modelTool)} | ${sanitizeCell(lockStatus)} | ${sanitizeCell(status, { backtick: true })} | ${sanitizeCell(paths)} |`;
  const kept = [];
  let replaced = false;
  const idLower = cleanId.toLowerCase();

  for (let i = sepIdx + 1; i < tableEnd; i += 1) {
    const cells = splitMdRow(lines[i]);
    if (!cells) continue;
    const first = cleanMdVal(cells[0]);
    if (!first || first === '暂无' || first === '-') continue;
    const rowCid = extractConvId(cells[0]).toLowerCase();
    if (rowCid && sameSessionId(rowCid, idLower)) {
      if (!replaced) {
        kept.push(newRow);
        replaced = true;
      }
    } else {
      kept.push(lines[i]);
    }
  }
  if (!replaced) kept.push(newRow);
  lines.splice(sepIdx + 1, tableEnd - (sepIdx + 1), ...kept);
  return lines.join('\n');
}

export function archiveActiveSession(mdText, { conversationId, milestone = '', summary = '-' } = {}) {
  const cleanId = sanitizeCell(conversationId, { backtick: false });
  if (!cleanId || cleanId === '-' || cleanId === '暂无') {
    throw new PathError(400, 'conversationId is required');
  }
  const lines = String(mdText ?? '').split(/\r?\n/);
  const sec3 = findSectionRange(
    lines,
    (t) => t.includes('活跃') || t.includes('挂起'),
    'Section 3 Active Sessions'
  );
  const b3 = findTableBoundsInRange(lines, sec3.start, sec3.end, 'Section 3 Active Sessions');

  const kept3 = [];
  let matchedRow = null;
  const idLower = cleanId.toLowerCase();

  for (let i = b3.sepIdx + 1; i < b3.tableEnd; i += 1) {
    const cells = splitMdRow(lines[i]);
    if (!cells) continue;
    const first = cleanMdVal(cells[0]);
    if (!first || first === '暂无' || first === '-') continue;
    const rowCid = extractConvId(cells[0]).toLowerCase();
    if (!matchedRow && rowCid && sameSessionId(rowCid, idLower)) {
      matchedRow = {
        conversationId: extractConvId(cells[0]) || cleanId,
        topic: cleanMdVal(cells[1]),
      };
      continue;
    }
    kept3.push(lines[i]);
  }
  if (!matchedRow) {
    throw new PathError(404, `Active session ${cleanId} not found in Section 3`);
  }
  if (kept3.length === 0) {
    kept3.push('| `暂无` | - | - | - | - | - |');
  }
  lines.splice(b3.sepIdx + 1, b3.tableEnd - (b3.sepIdx + 1), ...kept3);

  const sec4 = findSectionRange(lines, (t) => t.includes('归档'), 'Section 4 Archived Sessions');
  const b4 = findTableBoundsInRange(lines, sec4.start, sec4.end, 'Section 4 Archived Sessions');
  const kept4 = [];
  for (let i = b4.sepIdx + 1; i < b4.tableEnd; i += 1) {
    const cells = splitMdRow(lines[i]);
    if (!cells) continue;
    const first = cleanMdVal(cells[0]);
    if (!first || first === '暂无' || first === '-') continue;
    kept4.push(lines[i]);
  }
  const finalMilestone = sanitizeCell(milestone || matchedRow.topic || '已收口里程碑');
  const finalSummary = sanitizeCell(summary || '已完成并归档');
  kept4.push(`| ${formatConvCell(matchedRow.conversationId)} | ${finalMilestone} | ${finalSummary} |`);
  lines.splice(b4.sepIdx + 1, b4.tableEnd - (b4.sepIdx + 1), ...kept4);

  return lines.join('\n');
}

export function upsertQueueRow(mdText, item) {
  const idClean = sanitizeCell(item?.id, { backtick: false });
  if (!idClean || idClean === '-' || idClean === '暂无') {
    throw new PathError(400, 'Task ID is required');
  }
  const origClean = item?.originalId ? sanitizeCell(item.originalId, { backtick: false }) : idClean;
  const newLine = `| ${sanitizeCell(idClean, { backtick: true })} | ${sanitizeCell(item?.summary)} | ${sanitizeCell(item?.status || 'QUEUED', { backtick: true })} | ${sanitizeCell(item?.route || 'L2 Gemini 4 Neon (High)')} |`;

  const lines = String(mdText ?? '').split(/\r?\n/);
  const sec5 = findSectionRange(
    lines,
    (t) => t.includes('待调度') || t.includes('队列'),
    'Section 5 Task Queue'
  );
  const { sepIdx, tableEnd } = findTableBoundsInRange(lines, sec5.start, sec5.end, 'Section 5 Task Queue');

  const existingIds = new Set();
  for (let i = sepIdx + 1; i < tableEnd; i += 1) {
    const cells = splitMdRow(lines[i]);
    if (!cells) continue;
    const rowId = cleanMdVal(cells[0]);
    if (!rowId || rowId === '暂无' || rowId === '-' || PLACEHOLDER_RE.test(rowId)) continue;
    existingIds.add(rowId);
  }
  if (origClean !== idClean && existingIds.has(idClean)) {
    throw new PathError(409, `目标任务编号 ${idClean} 已存在于队列中，不能覆盖已有任务`, {
      error: 'duplicate_id',
    });
  }
  if (item?.requireNew === true && existingIds.has(idClean)) {
    throw new PathError(409, `任务编号 ${idClean} 已存在于队列中，如需修改请使用编辑操作`, {
      error: 'duplicate_id',
    });
  }

  const kept = [];
  let replaced = false;
  for (let i = sepIdx + 1; i < tableEnd; i += 1) {
    const cells = splitMdRow(lines[i]);
    if (!cells) continue;
    const rowId = cleanMdVal(cells[0]);
    if (!rowId || rowId === '暂无' || rowId === '-' || PLACEHOLDER_RE.test(rowId)) continue;
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

export function deleteQueueRow(mdText, id) {
  const targetId = sanitizeCell(id, { backtick: false });
  if (!targetId) throw new PathError(400, 'Task ID is required');

  const lines = String(mdText ?? '').split(/\r?\n/);
  const sec5 = findSectionRange(
    lines,
    (t) => t.includes('待调度') || t.includes('队列'),
    'Section 5 Task Queue'
  );
  const { sepIdx, tableEnd } = findTableBoundsInRange(lines, sec5.start, sec5.end, 'Section 5 Task Queue');

  const kept = [];
  let removed = false;
  for (let i = sepIdx + 1; i < tableEnd; i += 1) {
    const cells = splitMdRow(lines[i]);
    if (!cells) continue;
    const rowId = cleanMdVal(cells[0]);
    if (rowId === targetId) {
      removed = true;
      continue;
    }
    if (rowId && rowId !== '暂无' && rowId !== '-' && !PLACEHOLDER_RE.test(rowId)) kept.push(lines[i]);
  }
  if (!removed) throw new PathError(404, `Task ${targetId} not found in queue`);
  if (kept.length === 0) kept.push('| `暂无` | - | - | - |');
  lines.splice(sepIdx + 1, tableEnd - (sepIdx + 1), ...kept);
  return lines.join('\n');
}

export function extractTemplatesFromMarkdown(mdText) {
  const fallback = {
    registrySkeleton: '# 跨会话调度总账与资源租约登记表（SESSION-REGISTRY）\n',
    bootstrapPrompt: '',
    handoverTemplate: '',
    dispatchOfflineTemplate: '',
    dispatchGrantTemplate: '',
    domainLeadTemplate: '',
    handoffContractTemplate: '',
  };
  if (!mdText || typeof mdText !== 'string') return fallback;
  const getCodeBlockAfter = (headingPattern) => {
    const idx = mdText.search(headingPattern);
    if (idx < 0) return '';
    const sub = mdText.slice(idx);
    const m = sub.match(/```(?:markdown|text)?\r?\n([\s\S]*?)\r?\n```/);
    return m ? m[1].replace(/\r\n/g, '\n') : '';
  };
  return {
    registrySkeleton: getCodeBlockAfter(/^## 1\./m) || fallback.registrySkeleton,
    bootstrapPrompt: getCodeBlockAfter(/^## 2\./m),
    handoverTemplate: getCodeBlockAfter(/^## 3\./m),
    dispatchOfflineTemplate: getCodeBlockAfter(/^### 4\.1/m),
    dispatchGrantTemplate: getCodeBlockAfter(/^### 4\.2/m),
    domainLeadTemplate: getCodeBlockAfter(/^### 4\.3/m),
    handoffContractTemplate: getCodeBlockAfter(/^### 4\.4/m),
  };
}

export function extractTemplates(templatesPath) {
  if (!templatesPath || !existsSync(templatesPath)) {
    return extractTemplatesFromMarkdown('');
  }
  try {
    return extractTemplatesFromMarkdown(readFileSync(templatesPath, 'utf8'));
  } catch {
    return extractTemplatesFromMarkdown('');
  }
}
