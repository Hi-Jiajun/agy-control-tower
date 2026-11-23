import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  appendFlightEvent,
  clearFlightLogs,
  getFlightLogPath,
  readFlightEvents,
  sanitizeLogString,
  sanitizeLogValue,
  summarizeFlightEvents,
} from '../plugin/lib/logger.mjs';
import { formatMinerMarkdown, mineTelemetryAndLogs } from '../scripts/ct-miner.mjs';
import { makeConvId, makeSandbox, makeTranscriptPath } from './helpers.mjs';

test('Flight recorder logger sanitizes secrets/paths, rotates files, and summarizes health', () => {
  const sb = makeSandbox('ct-logger-');
  try {
    const dataDir = join(sb.dir, 'plugin_data');
    const fakeHomeSample = '/' + 'home' + '/alice/secret/project';
    const fakeIpSample = '192.' + '168.10.25';

    const clean = sanitizeLogString(
      `Failed at ${fakeHomeSample} via http://${fakeIpSample}:8080/?token=abc12345 Bearer supersecretkey999`
    );
    assert.equal(clean.includes('alice'), false);
    assert.equal(clean.includes(fakeIpSample), false);
    assert.equal(clean.includes('abc12345'), false);
    assert.equal(clean.includes('supersecretkey999'), false);
    assert.ok(clean.includes('<HOME>'));
    assert.ok(clean.includes('<PRIVATE_IP>'));
    assert.ok(clean.includes('<REDACTED>'));

    const sanitizedObj = sanitizeLogValue({ apiToken: 'xyz', nested: { password: 'p1', ok: true } });
    assert.equal(sanitizedObj.apiToken, '[REDACTED]');
    assert.equal(sanitizedObj.nested.password, '[REDACTED]');
    assert.equal(sanitizedObj.nested.ok, true);

    // Rotation test with small maxBytes
    for (let i = 0; i < 8; i += 1) {
      appendFlightEvent(
        dataDir,
        {
          level: i === 7 ? 'error' : i % 2 === 0 ? 'warn' : 'info',
          source: 'hook',
          event: i === 2 ? 'write_guard_triggered' : i === 4 ? 'slow_hook' : 'sample_event',
          durationMs: i === 4 ? 150 : 10,
          conv: makeConvId('a', '1', '4', '8', 'f'),
          message: `msg-${i}-${'x'.repeat(60)}`,
        },
        { maxBytes: 300, maxFiles: 3 }
      );
    }

    const logPath = getFlightLogPath(dataDir);
    assert.equal(existsSync(logPath), true);
    assert.equal(existsSync(`${logPath}.1`), true);

    const events = readFlightEvents(dataDir, { limit: 20 });
    assert.ok(events.length >= 2);
    assert.equal(events[0].level, 'error');
    assert.equal(events[0].conv.length, 8);

    const summary = summarizeFlightEvents(dataDir);
    assert.equal(summary.byLevel.error, 1);
    assert.ok(summary.total >= 2);

    clearFlightLogs(dataDir);
    assert.equal(readFlightEvents(dataDir).length, 0);
  } finally {
    sb.cleanup();
  }
});

test('Ring 2 telemetry miner clusters sandbox cache drops, edit mismatches, and flight errors into proposals', () => {
  const sb = makeSandbox('ct-miner-');
  try {
    const appData = join(sb.dir, 'app_data');
    const dataDir = join(sb.dir, 'plugin_data');
    const convA = makeConvId('a', '1', '4', '8', '1');
    const tp = makeTranscriptPath(appData, convA);

    const rows = [
      { step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high', input_tokens: 10000, cache_read_tokens: 90000, output_tokens: 500 },
      { step_index: 2, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high', input_tokens: 5000, cache_read_tokens: 95000, output_tokens: 400 },
      { step_index: 3, type: 'PLANNER_RESPONSE', model: 'gemini-4-carbon-high', input_tokens: 80000, cache_read_tokens: 20000, output_tokens: 600 },
      { step_index: 4, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high', input_tokens: 75000, cache_read_tokens: 25000, output_tokens: 400 },
      { step_index: 5, type: 'PLANNER_RESPONSE', model: 'gemini-4-carbon-high', input_tokens: 85000, cache_read_tokens: 15000, output_tokens: 400 },
      { step_index: 6, type: 'GENERIC', status: 'ERROR', content: 'target content not found' },
      { step_index: 7, type: 'GENERIC', status: 'ERROR', content: 'target content not found' },
      { step_index: 8, type: 'GENERIC', status: 'ERROR', content: 'target content not found' },
    ];
    writeFileSync(tp, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

    appendFlightEvent(dataDir, {
      level: 'error',
      source: 'sidecar',
      event: 'api_internal_error',
      message: 'Simulated error for miner',
    });

    const report = mineTelemetryAndLogs({ days: 7, appDataDir: appData, dataDir });
    assert.equal(report.scannedConversations, 1);
    assert.equal(report.totalPlannerSteps, 5);
    assert.equal(report.editMismatchCount, 3);
    const ids = report.proposals.map((p) => p.id);
    assert.ok(ids.includes('PROP-CACHE-SWITCH'), `Expected PROP-CACHE-SWITCH in ${ids.join(',')}`);
    assert.ok(ids.includes('PROP-EDIT-MISMATCH'), `Expected PROP-EDIT-MISMATCH in ${ids.join(',')}`);
    assert.ok(ids.includes('PROP-FLIGHT-ERRORS'), `Expected PROP-FLIGHT-ERRORS in ${ids.join(',')}`);

    const md = formatMinerMarkdown(report);
    assert.ok(md.includes('Control Tower 遥测复盘与改进提案报告'));
    assert.ok(md.includes('PROP-CACHE-SWITCH'));
  } finally {
    sb.cleanup();
  }
});
