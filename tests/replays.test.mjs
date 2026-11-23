import assert from 'node:assert/strict';
import test from 'node:test';
import { createReplaySkeletonFromFlightEvent, runAllReplays } from '../scripts/ct-replay.mjs';
import { runSkillEval } from '../scripts/ct-skill-eval.mjs';

test('Ring 3 + Ring 4 (L2): all sanitized incident replay fixtures pass', () => {
  const summary = runAllReplays();
  assert.ok(summary.total >= 12, `Expected at least 12 replay fixtures, found ${summary.total}`);
  assert.equal(
    summary.failed,
    0,
    `Failed replays: ${summary.results
      .filter((r) => !r.ok)
      .map((r) => `${r.id}: ${r.error}`)
      .join(' | ')}`
  );

  const sampleUuid = ['12345678', '1234', '4234', '8234', '1234567890ab'].join('-');
  const skeleton = createReplaySkeletonFromFlightEvent({
    ts: '2026-11-23T12:00:00Z',
    source: 'hook',
    event: 'state_save_failed',
    message: `disk full on ${sampleUuid}`,
  });
  assert.equal(skeleton.id, 'replay-state-save-failed');
  assert.equal(skeleton.kind, 'hook');
  assert.equal(skeleton.description.includes(sampleUuid), false);
  assert.ok(skeleton.description.includes('${OTHER_ID}'));
});

test('Ring 4 (L4): all 16 Skill & Prompt behavioral contract eval scenarios pass', () => {
  const summary = runSkillEval();
  assert.equal(summary.total, 16);
  assert.equal(
    summary.failed,
    0,
    `Failed skill evals: ${summary.results
      .filter((r) => !r.ok)
      .map((r) => `${r.id}: ${r.error}`)
      .join(' | ')}`
  );
});
