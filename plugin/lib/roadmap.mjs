import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertSafeTargetWithinRoot,
  atomicWriteText,
  getWorkspaceSettingsDir,
  isInsideDir,
  PathError,
  readJsonSafe,
  sha256,
  withFileLockSync,
} from './paths.mjs';

export const WORKSPACE_ROADMAP_L1_REL = '.agents/ROADMAP.md';
export const WORKSPACE_ROADMAP_L2_REL = '.agents/roadmap.json';
export const MANAGED_ROADMAP_L1_REL = '@plugin_data/ROADMAP.md';
export const MANAGED_ROADMAP_L2_REL = '@plugin_data/roadmap.json';

export const VALID_NODE_STATUSES = new Set(['planned', 'active', 'verified', 'done']);
export const VALID_ISOLATION_MODES = new Set(['inherit', 'share', 'branch']);
export const VALID_COLLAB_MODES = new Set([
  'swarm_channel',
  'workflow_pipeline',
  'handoff_file',
  'solo',
]);

export function buildDefaultRoadmapL1Markdown(projectName = '当前项目') {
  const safeName = String(projectName || '当前项目').replace(/[\r\n]+/g, ' ').trim();
  return `# ${safeName} 长期路线图与战略北极星（L1 ROADMAP）

> **定位说明**：本文件为低频变动的 L1 战略北极星（建议保持 1~2 页），用于确保总控在多轮换届与跨月推进中不偏离总体方向。中频分支拆解由同目录 \`roadmap.json\` 管理，实时运行会话由 \`SESSION-REGISTRY.md\` 记录。

## 一、长期愿景与阶段里程碑（Definition of Done）

- **M1（基础闭环）**：跑通核心主链路并建立可重复自动化验证门禁。
- **M2（能力扩展）**：按模块并行细化高优先子线并完成集成回归。

## 二、核心架构不变量与反目标（Invariants & Non-Goals）

- **架构不变量**：
  1. 保持模块边界清晰与客观可验证的验收标准；
  2. 并行修改前必须划定文件所有权边界并在合流前执行统一验收。
- **本阶段反目标（刻意不做）**：
  1. 不提前过度细化远期里程碑（遵循渐进式 Rolling Wave 规划）。

## 三、关键架构决策索引（ADR 摘要）

| 日期 | 编号 | 定案结论 |
| --- | --- | --- |
| ${new Date().toISOString().slice(0, 10)} | ADR-01 | 启用 L1 ROADMAP + L2 roadmap.json + L3 SESSION-REGISTRY 三层分离架构 |
`;
}

export function buildDefaultRoadmapL2(projectName = '当前项目') {
  const now = new Date().toISOString();
  return {
    version: 1,
    projectName: String(projectName || '当前项目').trim().slice(0, 80),
    updatedAt: now,
    milestones: [
      {
        id: 'M1',
        title: '核心基础闭环',
        dod: '核心主链路与自动化测试全绿通过',
        status: 'active',
      },
    ],
    nodes: [],
  };
}

function cleanString(val, fallback = '', maxLen = 200) {
  if (typeof val !== 'string') return fallback;
  const s = val.replace(/[\r\n]+/g, ' ').trim();
  return s ? s.slice(0, maxLen) : fallback;
}

function cleanId(val) {
  return cleanString(val, '', 48).replace(/[^A-Za-z0-9._-]/g, '');
}

function cleanStringArray(val, maxItems = 16, maxLen = 120) {
  if (typeof val === 'string') {
    val = val
      .split(/[,;，；、\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(val)) return [];
  const seen = new Set();
  const out = [];
  for (const item of val) {
    const s = cleanString(item, '', maxLen);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizePathPrefix(raw) {
  const trimmed = String(raw || '').trim().replace(/\\/g, '/');
  if (!trimmed) return '';
  if (trimmed === '.' || trimmed === './' || trimmed === '*' || trimmed === '**') return '*';
  const cleaned = trimmed
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/(?:\/\*\*|\/\*)+$/, '')
    .replace(/\/+$/, '');
  if (!cleaned) return '';
  return cleaned === '.' || cleaned === '*' || cleaned === '**' ? '*' : cleaned;
}

function globToRegex(globStr) {
  const escaped = globStr.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const reBody = escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${reBody}(?:$|/)`);
}

export function pathsOverlap(pathA, pathB) {
  const a = normalizePathPrefix(pathA);
  const b = normalizePathPrefix(pathB);
  if (!a || !b) return false;
  if (a === '*' || b === '*') return true;
  if (a === b) return true;
  if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true;
  if (a.includes('*') && !b.includes('*') && globToRegex(a).test(b)) return true;
  if (b.includes('*') && !a.includes('*') && globToRegex(b).test(a)) return true;
  if (a.includes('*') && b.includes('*')) {
    const dirA = a.split('*')[0].replace(/\/+$/, '');
    const dirB = b.split('*')[0].replace(/\/+$/, '');
    if (!dirA || !dirB || dirA === dirB || dirA.startsWith(`${dirB}/`) || dirB.startsWith(`${dirA}/`)) {
      return true;
    }
  }
  return false;
}

function sanitizeHandoffRelPath(raw, fallbackId) {
  const fallback = `.agents/handoffs/${fallbackId}.md`;
  const s = cleanString(raw, fallback, 160);
  if (
    !s ||
    !s.endsWith('.md') ||
    s.startsWith('/') ||
    s.startsWith('@') ||
    /^[A-Za-z]:/.test(s) ||
    /[\u0000-\u001f\u007f\\]/.test(s)
  ) {
    return fallback;
  }
  const segs = s.split('/');
  if (segs.some((seg) => !seg || seg === '.' || seg === '..')) {
    return fallback;
  }
  return s;
}

export function sanitizeRoadmapData(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const milestones = Array.isArray(src.milestones)
    ? src.milestones
        .filter((m) => m && typeof m === 'object' && cleanId(m.id))
        .map((m) => ({
          id: cleanId(m.id),
          title: cleanString(m.title, m.id, 100),
          dod: cleanString(m.dod, '-', 220),
          status: ['planned', 'active', 'done'].includes(m.status) ? m.status : 'planned',
        }))
    : [];

  const nodes = Array.isArray(src.nodes)
    ? src.nodes
        .filter((n) => n && typeof n === 'object' && cleanId(n.id))
        .map((n) => {
          const id = cleanId(n.id);
          const status = VALID_NODE_STATUSES.has(n.status) ? n.status : 'planned';
          const isolation = VALID_ISOLATION_MODES.has(n.isolation) ? n.isolation : 'share';
          const collaboration = VALID_COLLAB_MODES.has(n.collaboration)
            ? n.collaboration
            : 'swarm_channel';
          return {
            id,
            title: cleanString(n.title, id, 120),
            epic: cleanString(n.epic, 'Main', 60),
            milestoneId: cleanId(n.milestoneId) || milestones[0]?.id || 'M1',
            status,
            dependsOn: cleanStringArray(n.dependsOn, 16, 48)
              .map(cleanId)
              .filter((d) => d && d !== id),
            isolation,
            collaboration,
            ownership: cleanStringArray(n.ownership, 16, 160).map(normalizePathPrefix).filter(Boolean),
            acceptance: cleanString(n.acceptance, '-', 240),
            recommendedModel: cleanString(n.recommendedModel, 'Gemini 4 Neon (High)', 80),
            linkedConvId: cleanString(n.linkedConvId, '', 64),
            handoffPath: sanitizeHandoffRelPath(n.handoffPath, id),
            notes: cleanString(n.notes, '', 280),
            updatedAt: cleanString(n.updatedAt, '', 40) || new Date().toISOString(),
          };
        })
    : [];

  return {
    version: 1,
    projectName: cleanString(src.projectName, '当前项目', 80),
    updatedAt: cleanString(src.updatedAt, '', 40) || new Date().toISOString(),
    milestones,
    nodes,
  };
}

export function detectDependencyCycle(nodes) {
  const byId = new Map((nodes || []).map((n) => [n.id, n]));
  const color = new Map(); // 0=unvisited, 1=visiting, 2=done
  const cycleNodes = [];

  function dfs(id, stack) {
    color.set(id, 1);
    const node = byId.get(id);
    if (node) {
      for (const dep of node.dependsOn || []) {
        if (!byId.has(dep)) continue;
        const c = color.get(dep) || 0;
        if (c === 1) {
          const idx = stack.indexOf(dep);
          cycleNodes.push(...(idx >= 0 ? stack.slice(idx) : [dep, id]));
          return true;
        }
        if (c === 0 && dfs(dep, [...stack, dep])) {
          return true;
        }
      }
    }
    color.set(id, 2);
    return false;
  }

  for (const n of nodes || []) {
    if ((color.get(n.id) || 0) === 0) {
      if (dfs(n.id, [n.id])) {
        return { hasCycle: true, cycleNodes: [...new Set(cycleNodes)] };
      }
    }
  }
  return { hasCycle: false, cycleNodes: [] };
}

export function detectOwnershipOverlaps(evaluatedNodes) {
  const candidates = (evaluatedNodes || []).filter(
    (n) =>
      n &&
      (n.effectiveStatus === 'active' || n.effectiveStatus === 'ready') &&
      Array.isArray(n.ownership) &&
      n.ownership.length > 0
  );
  const overlaps = [];
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];
      // Skip if one explicitly depends on the other (sequential rather than concurrent)
      if ((a.dependsOn || []).includes(b.id) || (b.dependsOn || []).includes(a.id)) continue;
      const hits = [];
      for (const pa of a.ownership) {
        for (const pb of b.ownership) {
          if (pathsOverlap(pa, pb)) {
            hits.push(pa === pb ? pa : `${pa} <-> ${pb}`);
          }
        }
      }
      if (hits.length > 0) {
        overlaps.push({
          nodeA: a.id,
          nodeB: b.id,
          titleA: a.title,
          titleB: b.title,
          paths: [...new Set(hits)],
        });
      }
    }
  }
  return overlaps;
}

export function evaluateRoadmapGraph(rawRoadmap) {
  const data = sanitizeRoadmapData(rawRoadmap);
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const cycle = detectDependencyCycle(data.nodes);

  const isCompleted = (status) => status === 'done' || status === 'verified';

  const nodes = data.nodes.map((n) => {
    const unmetDeps = (n.dependsOn || []).filter((depId) => {
      const dep = byId.get(depId);
      return dep ? !isCompleted(dep.status) : false;
    });
    const missingDeps = (n.dependsOn || []).filter((depId) => !byId.has(depId));
    let effectiveStatus = n.status;
    if (n.status === 'planned') {
      effectiveStatus = unmetDeps.length === 0 && missingDeps.length === 0 ? 'ready' : 'blocked';
    }
    return {
      ...n,
      effectiveStatus,
      unmetDeps,
      missingDeps,
      canDispatch: effectiveStatus === 'ready',
    };
  });

  const overlaps = detectOwnershipOverlaps(nodes);

  const milestoneStats = data.milestones.map((m) => {
    const mNodes = nodes.filter((n) => n.milestoneId === m.id);
    const done = mNodes.filter((n) => isCompleted(n.status)).length;
    const active = mNodes.filter((n) => n.effectiveStatus === 'active').length;
    const ready = mNodes.filter((n) => n.effectiveStatus === 'ready').length;
    const blocked = mNodes.filter((n) => n.effectiveStatus === 'blocked').length;
    const total = mNodes.length;
    return {
      ...m,
      total,
      done,
      active,
      ready,
      blocked,
      pct: total > 0 ? Math.round((done / total) * 100) : m.status === 'done' ? 100 : 0,
    };
  });

  const counts = {
    total: nodes.length,
    ready: nodes.filter((n) => n.effectiveStatus === 'ready').length,
    active: nodes.filter((n) => n.effectiveStatus === 'active').length,
    blocked: nodes.filter((n) => n.effectiveStatus === 'blocked').length,
    done: nodes.filter((n) => isCompleted(n.status)).length,
  };

  return {
    hasCycle: cycle.hasCycle,
    cycleNodes: cycle.cycleNodes,
    counts,
    readyIds: nodes.filter((n) => n.effectiveStatus === 'ready').map((n) => n.id),
    overlaps,
    milestoneStats,
    nodes,
  };
}

export function extractNorthStarBrief(l1Markdown) {
  if (typeof l1Markdown !== 'string' || !l1Markdown.trim()) return '';
  const heading = l1Markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || '';
  const bullets = [];
  for (const line of l1Markdown.split(/\r?\n/)) {
    const t = line.trim();
    if (/^-\s+\*\*M\d+/.test(t)) {
      bullets.push(t.replace(/^-\s+/, '').replace(/\*\*/g, '').slice(0, 70));
      if (bullets.length >= 2) break;
    }
  }
  return [heading, ...bullets].filter(Boolean).join(' | ').slice(0, 200);
}

export function resolveRoadmapPaths(wsReal, { dataDir = '', storageMode = 'workspace' } = {}) {
  if (!wsReal) throw new PathError(400, 'workspace is required');
  if (storageMode === 'plugin_data') {
    if (!dataDir) throw new PathError(400, 'dataDir is required for plugin_data roadmap');
    const dir = getWorkspaceSettingsDir(dataDir, wsReal);
    return {
      isManaged: true,
      l1Rel: MANAGED_ROADMAP_L1_REL,
      l2Rel: MANAGED_ROADMAP_L2_REL,
      l1Abs: join(dir, 'ROADMAP.md'),
      l2Abs: join(dir, 'roadmap.json'),
    };
  }
  const wsCanon = existsSync(wsReal) ? realpathSync(wsReal) : resolve(wsReal);
  const l1Abs = assertSafeTargetWithinRoot(wsCanon, join(wsCanon, '.agents', 'ROADMAP.md'), {
    allowMissing: true,
    rootLabel: 'workspace',
  });
  const l2Abs = assertSafeTargetWithinRoot(wsCanon, join(wsCanon, '.agents', 'roadmap.json'), {
    allowMissing: true,
    rootLabel: 'workspace',
  });
  return {
    isManaged: false,
    l1Rel: WORKSPACE_ROADMAP_L1_REL,
    l2Rel: WORKSPACE_ROADMAP_L2_REL,
    l1Abs,
    l2Abs,
  };
}

function withRoadmapLock(wsReal, dataDir, fn) {
  const lockPath = dataDir
    ? join(getWorkspaceSettingsDir(dataDir, wsReal), '.roadmap.lock')
    : join(wsReal, '.agents', '.roadmap.lock');
  return withFileLockSync(lockPath, fn);
}

/**
 * Strictly read-only discovery of existing workspace or managed roadmap files.
 */
export function findExistingRoadmap(wsReal, { dataDir = '', workspaceSettings = null } = {}) {
  if (!wsReal) return null;
  const preferManaged = workspaceSettings?.registryMode === 'plugin_data';
  const order = preferManaged ? ['plugin_data', 'workspace'] : ['workspace', 'plugin_data'];

  for (const mode of order) {
    if (mode === 'plugin_data' && !dataDir) continue;
    try {
      const p = resolveRoadmapPaths(wsReal, { dataDir, storageMode: mode });
      if (existsSync(p.l2Abs) || existsSync(p.l1Abs)) {
        return p;
      }
    } catch (err) {
      if (err instanceof PathError && err.message.includes('symlink')) {
        throw err;
      }
    }
  }
  return null;
}

const MAX_HANDOFF_PREVIEW_BYTES = 4096;

/**
 * Read-only safe inspection of a node's cross-wave handoff contract file (.agents/handoffs/<id>.md).
 * Blocks path traversal, parent/leaf symlink escapes, non-.md files, and unbounded reads.
 */
export function inspectNodeHandoff(wsReal, node) {
  const rawRel = cleanString(node?.handoffPath, node?.id ? `.agents/handoffs/${node.id}.md` : '', 160);
  const empty = { exists: false, relPath: rawRel, preview: '', bytes: 0, updatedAt: '' };
  if (!wsReal || !rawRel || !rawRel.endsWith('.md')) return empty;
  if (rawRel.startsWith('/') || rawRel.includes('..') || rawRel.includes('\\')) return empty;
  let fd;
  try {
    const wsCanon = realpathSync(wsReal);
    const abs = resolve(wsCanon, rawRel);
    assertSafeTargetWithinRoot(wsCanon, abs, { allowMissing: false, rootLabel: 'workspace' });
    const targetReal = realpathSync(abs);
    if (!isInsideDir(wsCanon, targetReal)) return empty;
    const st = statSync(targetReal);
    if (!st.isFile()) return empty;
    const readLen = Math.min(MAX_HANDOFF_PREVIEW_BYTES, st.size);
    let raw = '';
    if (readLen > 0) {
      fd = openSync(targetReal, 'r');
      const buf = Buffer.allocUnsafe(readLen);
      const n = readSync(fd, buf, 0, readLen, 0);
      raw = buf.subarray(0, Math.max(0, n)).toString('utf8');
    }
    const trimmed = raw.trim();
    const preview = trimmed.length > 600 ? `${trimmed.slice(0, 597)}...` : trimmed;
    return {
      exists: true,
      relPath: rawRel,
      preview,
      bytes: st.size,
      updatedAt: new Date(st.mtimeMs).toISOString(),
    };
  } catch {
    return empty;
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

export function loadWorkspaceRoadmap(
  wsReal,
  { dataDir = '', workspaceSettings = null, includeHandoffs = true } = {}
) {
  const found = findExistingRoadmap(wsReal, { dataDir, workspaceSettings });
  if (!found) {
    return {
      exists: false,
      isManaged: false,
      l1Rel: '',
      l2Rel: '',
      l1Path: '',
      l2Path: '',
      l1Hash: '',
      l2Hash: '',
      l1Content: '',
      northStarBrief: '',
      data: null,
      graph: null,
    };
  }
  const l1Content = existsSync(found.l1Abs) ? readFileSync(found.l1Abs, 'utf8') : '';
  const l2RawText = existsSync(found.l2Abs) ? readFileSync(found.l2Abs, 'utf8') : '';
  let rawL2 = null;
  if (l2RawText) {
    try {
      rawL2 = JSON.parse(l2RawText);
    } catch {
      rawL2 = null;
    }
  }
  const data = sanitizeRoadmapData(rawL2 || buildDefaultRoadmapL2(basename(wsReal)));
  const graph = evaluateRoadmapGraph(data);
  if (includeHandoffs) {
    graph.nodes = graph.nodes.map((n) => ({
      ...n,
      handoff: inspectNodeHandoff(wsReal, n),
    }));
  } else {
    graph.nodes = graph.nodes.map((n) => ({
      ...n,
      handoff: { exists: false, relPath: n.handoffPath || `.agents/handoffs/${n.id}.md`, bytes: 0, preview: '' },
    }));
  }
  return {
    exists: true,
    isManaged: found.isManaged,
    l1Rel: found.l1Rel,
    l2Rel: found.l2Rel,
    l1Path: found.l1Abs,
    l2Path: found.l2Abs,
    l1Hash: l1Content ? sha256(l1Content) : '',
    l2Hash: l2RawText ? sha256(l2RawText) : '',
    l1Content,
    northStarBrief: extractNorthStarBrief(l1Content),
    data,
    graph,
  };
}

export function initWorkspaceRoadmap(
  wsReal,
  { dataDir = '', storageMode = 'workspace', projectName = '' } = {}
) {
  const paths = resolveRoadmapPaths(wsReal, { dataDir, storageMode });
  if (existsSync(paths.l2Abs)) {
    throw new PathError(409, `Roadmap already exists: ${paths.l2Rel}`);
  }
  const name = cleanString(projectName, basename(wsReal) || '当前项目', 80);
  if (!existsSync(paths.l1Abs)) {
    atomicWriteText(paths.l1Abs, buildDefaultRoadmapL1Markdown(name));
  }
  const data = buildDefaultRoadmapL2(name);
  atomicWriteText(paths.l2Abs, `${JSON.stringify(data, null, 2)}\n`);
  return loadWorkspaceRoadmap(wsReal, {
    dataDir,
    workspaceSettings: { registryMode: storageMode === 'plugin_data' ? 'plugin_data' : 'workspace_auto' },
  });
}

export function saveRoadmapL1(
  wsReal,
  content,
  { dataDir = '', workspaceSettings = null, expectedL1Hash = '' } = {}
) {
  return withRoadmapLock(wsReal, dataDir, () => {
    const loaded = loadWorkspaceRoadmap(wsReal, { dataDir, workspaceSettings });
    if (!loaded.exists) throw new PathError(404, 'Roadmap not initialized in workspace');
    if (expectedL1Hash && loaded.l1Hash && expectedL1Hash !== loaded.l1Hash) {
      throw new PathError(409, 'ROADMAP.md 已被外部修改，请重载后再保存', { error: 'hash_conflict' });
    }
    if (typeof content !== 'string') throw new PathError(400, 'content must be a string');
    if (Buffer.byteLength(content, 'utf8') > 256 * 1024) {
      throw new PathError(413, 'ROADMAP.md exceeds 256KB cap');
    }
    atomicWriteText(loaded.l1Path, content.endsWith('\n') ? content : `${content}\n`);
    return loadWorkspaceRoadmap(wsReal, { dataDir, workspaceSettings });
  });
}

export function upsertRoadmapMilestone(
  wsReal,
  milestone,
  { dataDir = '', workspaceSettings = null, expectedL2Hash = '' } = {}
) {
  return withRoadmapLock(wsReal, dataDir, () => {
    const loaded = loadWorkspaceRoadmap(wsReal, { dataDir, workspaceSettings });
    if (!loaded.exists) throw new PathError(404, 'Roadmap not initialized in workspace');
    if (expectedL2Hash && loaded.l2Hash && expectedL2Hash !== loaded.l2Hash) {
      throw new PathError(409, 'roadmap.json 已被外部修改，请刷新后再保存', { error: 'hash_conflict' });
    }
    const id = cleanId(milestone?.id);
    if (!id) throw new PathError(400, 'Milestone id is required');
    const data = sanitizeRoadmapData(loaded.data);
    const nextItem = {
      id,
      title: cleanString(milestone?.title, id, 100),
      dod: cleanString(milestone?.dod, '-', 220),
      status: ['planned', 'active', 'done'].includes(milestone?.status) ? milestone.status : 'active',
    };
    const idx = data.milestones.findIndex((m) => m.id === id);
    if (idx >= 0) data.milestones[idx] = nextItem;
    else data.milestones.push(nextItem);
    data.updatedAt = new Date().toISOString();
    atomicWriteText(loaded.l2Path, `${JSON.stringify(data, null, 2)}\n`);
    return loadWorkspaceRoadmap(wsReal, { dataDir, workspaceSettings });
  });
}

export function upsertRoadmapNode(
  wsReal,
  nodeInput,
  { dataDir = '', workspaceSettings = null, expectedL2Hash = '' } = {}
) {
  return withRoadmapLock(wsReal, dataDir, () => {
    const loaded = loadWorkspaceRoadmap(wsReal, { dataDir, workspaceSettings });
    if (!loaded.exists) throw new PathError(404, 'Roadmap not initialized in workspace');
    if (expectedL2Hash && loaded.l2Hash && expectedL2Hash !== loaded.l2Hash) {
      throw new PathError(409, 'roadmap.json 已被外部修改，请刷新后再保存', { error: 'hash_conflict' });
    }
    const id = cleanId(nodeInput?.id);
    if (!id) throw new PathError(400, 'Workstream node id is required');

    const data = sanitizeRoadmapData(loaded.data);
    const hasExplicitOrig = Boolean(cleanId(nodeInput?.originalId));
    const origId = cleanId(nodeInput?.originalId) || id;
    const prevIdx = data.nodes.findIndex((n) => n.id === origId);
    const prev = prevIdx >= 0 ? data.nodes[prevIdx] : null;

    if (!hasExplicitOrig && nodeInput?.requireNew === true && prev) {
      throw new PathError(409, `分支节点 ${id} 已存在，如需修改请使用编辑操作`, {
        error: 'duplicate_id',
      });
    }
    if (origId !== id && data.nodes.some((n) => n.id === id)) {
      throw new PathError(409, `目标分支节点 ${id} 已存在，不能覆盖已有节点`, {
        error: 'duplicate_id',
      });
    }

    const mergedNode = {
      ...(prev || {}),
      ...nodeInput,
      id,
      handoffPath:
        nodeInput?.handoffPath !== undefined
          ? nodeInput.handoffPath
          : prev && origId === id
            ? prev.handoffPath
            : `.agents/handoffs/${id}.md`,
      updatedAt: new Date().toISOString(),
    };

    const nextNodes = [];
    let inserted = false;
    for (let i = 0; i < data.nodes.length; i += 1) {
      const cur = data.nodes[i];
      if (i === prevIdx) {
        nextNodes.push(mergedNode);
        inserted = true;
      } else if (cur.id !== id && cur.id !== origId) {
        const migratedDeps =
          prev && origId !== id
            ? (cur.dependsOn || []).map((d) => (d === origId ? id : d))
            : cur.dependsOn;
        nextNodes.push({ ...cur, dependsOn: migratedDeps });
      }
    }
    if (!inserted) {
      nextNodes.push(mergedNode);
    }

    const candidate = sanitizeRoadmapData({
      ...data,
      nodes: nextNodes,
    });

    const cycle = detectDependencyCycle(candidate.nodes);
    if (cycle.hasCycle) {
      throw new PathError(400, `检测到循环依赖 (${cycle.cycleNodes.join(' -> ')})，已拒绝保存。`);
    }

    candidate.updatedAt = new Date().toISOString();
    atomicWriteText(loaded.l2Path, `${JSON.stringify(candidate, null, 2)}\n`);
    return loadWorkspaceRoadmap(wsReal, { dataDir, workspaceSettings });
  });
}

export function updateRoadmapNodeStatus(
  wsReal,
  { id, status, linkedConvId } = {},
  { dataDir = '', workspaceSettings = null, expectedL2Hash = '', onlyIfNotDone = false } = {}
) {
  return withRoadmapLock(wsReal, dataDir, () => {
    const loaded = loadWorkspaceRoadmap(wsReal, { dataDir, workspaceSettings });
    if (!loaded.exists) throw new PathError(404, 'Roadmap not initialized in workspace');
    if (expectedL2Hash && loaded.l2Hash && expectedL2Hash !== loaded.l2Hash) {
      throw new PathError(409, 'roadmap.json 已被外部修改，请刷新后再保存', { error: 'hash_conflict' });
    }
    const targetId = cleanId(id);
    if (!targetId) throw new PathError(400, 'Node id is required');
    if (status && !VALID_NODE_STATUSES.has(status)) {
      throw new PathError(400, `Invalid node status: ${status}`);
    }

    const prevReadySet = new Set(loaded.graph?.readyIds || []);
    const data = sanitizeRoadmapData(loaded.data);
    const node = data.nodes.find((n) => n.id === targetId);
    if (!node) throw new PathError(404, `Workstream node ${targetId} not found`);

    if (status && !(onlyIfNotDone && (node.status === 'done' || node.status === 'verified'))) {
      node.status = status;
    }
    if (linkedConvId !== undefined) node.linkedConvId = cleanString(linkedConvId, '', 64);
    node.updatedAt = new Date().toISOString();
    data.updatedAt = node.updatedAt;

    atomicWriteText(loaded.l2Path, `${JSON.stringify(data, null, 2)}\n`);
    const next = loadWorkspaceRoadmap(wsReal, { dataDir, workspaceSettings });
    const newlyUnlocked = (next.graph?.nodes || [])
      .filter((n) => n.effectiveStatus === 'ready' && !prevReadySet.has(n.id) && n.id !== targetId)
      .map((n) => ({ id: n.id, title: n.title, isolation: n.isolation }));

    return { roadmap: next, newlyUnlocked };
  });
}

export function deleteRoadmapNode(
  wsReal,
  id,
  { dataDir = '', workspaceSettings = null, expectedL2Hash = '' } = {}
) {
  return withRoadmapLock(wsReal, dataDir, () => {
    const loaded = loadWorkspaceRoadmap(wsReal, { dataDir, workspaceSettings });
    if (!loaded.exists) throw new PathError(404, 'Roadmap not initialized in workspace');
    if (expectedL2Hash && loaded.l2Hash && expectedL2Hash !== loaded.l2Hash) {
      throw new PathError(409, 'roadmap.json 已被外部修改，请刷新后再保存', { error: 'hash_conflict' });
    }
    const targetId = cleanId(id);
    const data = sanitizeRoadmapData(loaded.data);
    const nextNodes = data.nodes.filter((n) => n.id !== targetId);
    if (nextNodes.length === data.nodes.length) {
      throw new PathError(404, `Workstream node ${targetId} not found`);
    }
    for (const n of nextNodes) {
      n.dependsOn = (n.dependsOn || []).filter((d) => d !== targetId);
    }
    data.nodes = nextNodes;
    data.updatedAt = new Date().toISOString();
    atomicWriteText(loaded.l2Path, `${JSON.stringify(data, null, 2)}\n`);
    return loadWorkspaceRoadmap(wsReal, { dataDir, workspaceSettings });
  });
}

/**
 * Direction 3 + Direction 4 Bridge:
 * Generates a Four-Quadrant Isolation & Collaboration Contract Prompt for a Roadmap branch node.
 */
export function buildWorkstreamContractPrompt(
  node,
  {
    controllerId = '',
    exclusiveLeaseEnabled = true,
    registryRelPath = '.agents/SESSION-REGISTRY.md',
    northStarBrief = '',
    overlaps = [],
  } = {}
) {
  if (!node || !node.id) throw new PathError(400, 'Valid workstream node is required');

  const isoMap = {
    inherit: 'workspace: "inherit"（只读调研或轻验，严禁覆盖并行分支代码）',
    share: 'workspace: "share"（共享仓独立工作树，并行改代码互不踩踏，完工后由 L4 统一合流验收）',
    branch: 'workspace: "branch"（完全独立克隆，适合重装依赖或破坏性重构）',
  };
  const collabMap = {
    swarm_channel: '紧耦合并肩协作：在原生 Swarm 共享频道直接 @同行 同步接口与对抗复验，勿将中间细节塞回主总控',
    workflow_pipeline: '松耦合确定性流水线：按 run_workflow pipeline 与强 JSON schema 契约交付结构化结果',
    handoff_file: `跨波次接力契约：完工时将接口契约、验证命令与雷区落盘至 ${node.handoffPath || `.agents/handoffs/${node.id}.md`}`,
    solo: '独立单线推进：聚焦自身所有权边界完成验证后直接回报交付摘要',
  };

  const ownershipText =
    Array.isArray(node.ownership) && node.ownership.length > 0
      ? node.ownership.join(', ')
      : '未显式限定（改动跨模块公共接口前须先请示总控）';

  const overlapWarn =
    Array.isArray(overlaps) && overlaps.length > 0
      ? `\n【所有权重叠预警】：当前与 ${overlaps.map((o) => `${o.nodeA}/${o.nodeB}(${o.paths.join(',')})`).join('; ')} 存在路径交集，请严格在独立工作树作业并避免擅改公共签名前置协商。`
      : '';

  const leaseLine = exclusiveLeaseEnabled
    ? '独占资源约束：未获授锁前保持 100% 纯离线作业。'
    : '当前工作区处于无独占资源模式。';

  const ctrlPart = controllerId
    ? `现役总控: ${controllerId}。遇接口/范围分叉或连续 2 轮失败请发送 [CT_REPORT:DECISION] [${node.id}] ...，收口发送 [CT_REPORT:DONE] [${node.id}] <交付摘要与验证结果> | 【可沉淀经验候选】：<1~3行或无>。`
    : '收口后请输出结构化交付清单与验证命令输出。';

  return (
    `【工作包分支契约】${node.id} | ${node.title} (里程碑: ${node.milestoneId || '-'} | 史诗: ${node.epic || '-'})\n` +
    (northStarBrief ? `【L1 战略北极星】：${northStarBrief}\n` : '') +
    `【物理隔离档位】：${isoMap[node.isolation] || isoMap.share}\n` +
    `【协作拓扑协议】：${collabMap[node.collaboration] || collabMap.swarm_channel}\n` +
    `【文件所有权边界（Ownership Map）】：${ownershipText}${overlapWarn}\n` +
    `【客观验收判据（Acceptance Gate）】：${node.acceptance || '请执行对应模块测试并给出实测退出码与输出'}\n` +
    `【前置依赖】：${(node.dependsOn || []).length > 0 ? node.dependsOn.join(', ') : '无（已就绪）'}\n` +
    `【合流与台账红线】：${leaseLine}严禁直接修改 ${registryRelPath}，亦严禁私改 AGENTS.md / .agents/rules/ / 技能文件（经验候选随 DONE 上报由总控呈批）；并行分支不得擅自强推主干，须待验收通过后统一合流。${ctrlPart}\n` +
    `【执行与缓存纪律】：先批量只读再动笔；跨回合 edit_file 前必须先 read_file 对齐目标区域最新缩进，同一文件连续 2 次不匹配立即重读目标行段或改用 write_file，严禁循环盲试。`
  );
}
