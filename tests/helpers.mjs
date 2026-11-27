import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function makeSandbox(prefix = 'ct-test-') {
  const rawDir = mkdtempSync(join(tmpdir(), prefix));
  const dir = realpathSync(rawDir);
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function makeConvId(a = 'a', b = '1', c = '4', d = '8', e = 'f') {
  return [
    a.repeat(8),
    b.repeat(4),
    c.repeat(4),
    d.repeat(4),
    e.repeat(12),
  ].join('-');
}

export function makeTranscriptPath(appDataDir, convId) {
  const p = join(appDataDir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  mkdirSync(join(appDataDir, 'brain', convId, '.system_generated', 'logs'), { recursive: true });
  return p;
}
