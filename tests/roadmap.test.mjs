import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PathError } from '../plugin/lib/paths.mjs';
import {
  buildWorkstreamContractPrompt,
  deleteRoadmapNode,
  initWorkspaceRoadmap,
  loadWorkspaceRoadmap,
  pathsOverlap,
  saveRoadmapL1,
  updateRoadmapNodeStatus,
  upsertRoadmapMilestone,
  upsertRoadmapNode,
} from '../plugin/lib/roadmap.mjs';
import { makeConvId, makeSandbox } from './helpers.mjs';

const HOOK_SCRIPT = join(process.cwd(), 'plugin', 'scripts', 'ct-hook.mjs');

test('Phase 3: 3-tier hybrid roadmap supports DAG readiness, cycle rejection, ownership overlap guard, unlock propagation, and contract prompts', () => {
  const sb = makeSandbox('ct-roadmap-');
  try {
    const ws = join(sb.dir, 'ws');
    const wsClean = join(sb.dir, 'ws-clean');
    const dataDir = join(sb.dir, 'plugin_data');
    mkdirSync(ws, { recursive: true });
    mkdirSync(wsClean, { recursive: true });

    // Read-only discovery on empty workspace creates zero files
    const empty = loadWorkspaceRoadmap(ws, { dataDir });
    assert.equal(empty.exists, false);
    assert.equal(existsSync(join(ws, '.agents')), false);
    assert.equal(existsSync(dataDir), false);

    // 1) Workspace mode init creates L1 ROADMAP.md + L2 roadmap.json
    const init = initWorkspaceRoadmap(ws, { dataDir, storageMode: 'workspace', projectName: 'MegaProject' });
    assert.equal(init.exists, true);
    assert.equal(init.isManaged, false);
    assert.equal(existsSync(join(ws, '.agents', 'ROADMAP.md')), true);
    assert.equal(existsSync(join(ws, '.agents', 'roadmap.json')), true);

    // 2) Add milestones & branch nodes with dependencies + overlapping ownership
    upsertRoadmapMilestone(ws, { id: 'M2', title: '并发协同', dod: '集成测试全绿', status: 'planned' }, { dataDir });

    upsertRoadmapNode(
      ws,
      {
        id: 'W1',
        title: '核心接口契约',
        milestoneId: 'M1',
        epic: 'Core',
        status: 'active',
        isolation: 'share',
        collaboration: 'swarm_channel',
        ownership: ['src/core/', 'src/shared/types.mjs'],
        acceptance: 'npm test',
      },
      { dataDir }
    );
    upsertRoadmapNode(
      ws,
      {
        id: 'W2',
        title: '模块A实现',
        milestoneId: 'M1',
        epic: 'Core',
        status: 'planned',
        dependsOn: ['W1'],
        isolation: 'share',
        collaboration: 'swarm_channel',
        ownership: ['src/mod-a/'],
        acceptance: 'npm test -- mod-a',
      },
      { dataDir }
    );
    const withW3 = upsertRoadmapNode(
      ws,
      {
        id: 'W3',
        title: '并发边界冲突检查样本',
        milestoneId: 'M1',
        epic: 'Core',
        status: 'planned',
        dependsOn: [],
        isolation: 'share',
        collaboration: 'handoff_file',
        ownership: ['src/core/parser.mjs'],
        acceptance: 'npm test -- parser',
      },
      { dataDir }
    );

    // W1 (active) & W3 (ready) overlap on src/core/ <-> src/core/parser.mjs!
    assert.equal(pathsOverlap('src/core/', 'src/core/parser.mjs'), true);
    assert.equal(pathsOverlap('src/mod-a/', 'src/mod-b/'), false);
    assert.equal(withW3.graph.overlaps.length, 1);
    assert.equal(withW3.graph.overlaps[0].nodeA, 'W1');
    assert.equal(withW3.graph.overlaps[0].nodeB, 'W3');

    // W2 is blocked by W1; W3 is ready
    const w2Node = withW3.graph.nodes.find((n) => n.id === 'W2');
    const w3Node = withW3.graph.nodes.find((n) => n.id === 'W3');
    assert.equal(w2Node.effectiveStatus, 'blocked');
    assert.deepEqual(w2Node.unmetDeps, ['W1']);
    assert.equal(w3Node.effectiveStatus, 'ready');

    // 3) Cycle detection rejects W1 depending on W2
    assert.throws(
      () =>
        upsertRoadmapNode(
          ws,
          { id: 'W1', title: '核心接口契约', dependsOn: ['W2'], status: 'active' },
          { dataDir }
        ),
      PathError
    );

    // 4) Contract prompt includes isolation, collaboration, ownership, and overlap warning
    const ctrlId = makeConvId('c', '1', '4', '8', 'a');
    const contract = buildWorkstreamContractPrompt(w3Node, {
      controllerId: ctrlId,
      exclusiveLeaseEnabled: false,
      northStarBrief: withW3.northStarBrief,
      overlaps: withW3.graph.overlaps,
    });
    assert.ok(contract.includes('workspace: "share"'));
    assert.ok(contract.includes('.agents/handoffs/W3.md'));
    assert.ok(contract.includes('所有权重叠预警'));
    assert.ok(contract.includes(ctrlId));

    // 5) Marking W1 done unlocks W2 immediately!
    const doneRes = updateRoadmapNodeStatus(ws, { id: 'W1', status: 'done' }, { dataDir });
    assert.equal(doneRes.newlyUnlocked.length, 1);
    assert.equal(doneRes.newlyUnlocked[0].id, 'W2');

    // 6) L1 save & node delete clean up references
    const savedL1 = saveRoadmapL1(ws, '# Custom North Star\n- **M1**：目标达成\n', { dataDir });
    assert.ok(savedL1.northStarBrief.includes('Custom North Star'));
    const afterDel = deleteRoadmapNode(ws, 'W3', { dataDir });
    assert.equal(afterDel.graph.counts.total, 2);

    // 7) Zero-intrusion PLUGIN_DATA roadmap writes ZERO files inside wsClean
    const managed = initWorkspaceRoadmap(wsClean, { dataDir, storageMode: 'plugin_data', projectName: 'CleanRepo' });
    assert.equal(managed.exists, true);
    assert.equal(managed.isManaged, true);
    assert.equal(existsSync(join(wsClean, '.agents')), false);

    // 8) SessionStart controller brief automatically includes Roadmap progress & ready branches
    writeFileSync(
      join(ws, '.agents', 'SESSION-REGISTRY.md'),
      `# 台账\n## 一、当前独占资源租约\n| 字段 | 当前值 |\n| --- | --- |\n| **锁状态** | \`IDLE\` |\n## 二、常驻主交流总控会话\n- **当前现役总控会话**：\`${ctrlId}\`（状态：\`ONLINE\`）\n`,
      'utf8'
    );
    const ssOut = JSON.parse(
      execFileSync(process.execPath, [HOOK_SCRIPT, 'SessionStart'], {
        input: JSON.stringify({ conversationId: ctrlId, workspacePaths: [ws] }),
        encoding: 'utf8',
        env: { ...process.env, AGY_CONTROL_TOWER_DATA_DIR: dataDir },
      })
    );
    const ssText = ssOut.injectSteps?.[0]?.systemMessage?.systemMessage || '';
    assert.ok(ssText.includes('路线图(工作区): 1/2 完成'));
    assert.ok(ssText.includes('就绪可并行分支: W2'));
  } finally {
    sb.cleanup();
  }
});
