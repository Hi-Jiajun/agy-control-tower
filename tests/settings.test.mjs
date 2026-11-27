import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PathError } from '../plugin/lib/paths.mjs';
import {
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_PLUGIN_SETTINGS,
  normalizeModelForAgentApi,
  readHostPermissionPolicy,
  resetDocOverride,
  resetGlobalSettings,
  resetPluginSettings,
  resetWorkspaceSettings,
  resolveEffectiveAutonomy,
  resolveEffectiveSettings,
  saveDocOverride,
  saveGlobalSettings,
  savePluginSettings,
  saveWorkspaceSettings,
  validateDispatchModel,
} from '../plugin/lib/settings.mjs';
import { makeSandbox } from './helpers.mjs';

test('3-tier settings stay isolated, never create files on read, and support reset + overrides', () => {
  const sb = makeSandbox();
  try {
    const dataDir = join(sb.dir, 'plugin_data');
    const wsA = join(sb.dir, 'wsA');
    const wsB = join(sb.dir, 'wsB');
    const pluginRoot = join(process.cwd(), 'plugin');
    mkdirSync(wsA, { recursive: true });
    mkdirSync(wsB, { recursive: true });

    // 1) Read-only check must NOT create plugin_data directory
    const initRead = resolveEffectiveSettings({ dataDir, wsReal: wsA, pluginRoot });
    assert.equal(existsSync(dataDir), false);
    assert.deepEqual(initRead.plugin, DEFAULT_PLUGIN_SETTINGS);
    assert.equal(initRead.effective.controllerCompactionThreshold, 5);
    assert.equal(initRead.docs['model-routing.md'].source, 'builtin');

    // 2) Plugin layer changes do not touch global/workspace
    const ps = savePluginSettings(dataDir, {
      livePollIntervalSec: 120, // clamped to 60
      registryWriteGuard: 'deny',
      uiMotion: 'reduced',
    });
    assert.equal(ps.livePollIntervalSec, 60);
    assert.equal(ps.registryWriteGuard, 'deny');
    assert.equal(existsSync(join(dataDir, 'global-settings.json')), false);

    // 3) Global layer & doc override affect workspaces unless overridden locally
    saveGlobalSettings(dataDir, {
      controllerCompactionThreshold: 7,
      l2StandardModel: 'Orchestrator (Carbon)',
    });
    saveDocOverride(dataDir, 'global', 'model-routing.md', '# Global Override\n');

    // 4) Workspace A overrides threshold & routing; Workspace B inherits global
    saveWorkspaceSettings(dataDir, wsA, {
      exclusiveLeaseEnabled: false,
      registryMode: 'plugin_data',
      overrides: { controllerCompactionThreshold: 4, askBeforeDispatch: false },
    });
    saveDocOverride(dataDir, 'workspace', 'model-routing.md', '# Workspace A Override\n', wsA);

    const effA = resolveEffectiveSettings({ dataDir, wsReal: wsA, pluginRoot });
    const effB = resolveEffectiveSettings({ dataDir, wsReal: wsB, pluginRoot });

    assert.equal(effA.effective.exclusiveLeaseEnabled, false);
    assert.equal(effA.effective.controllerCompactionThreshold, 4);
    assert.equal(effA.effective.l2StandardModel, 'Orchestrator (Carbon)');
    assert.equal(effA.sourceMap.controllerCompactionThreshold, 'workspace');
    assert.equal(effA.sourceMap.l2StandardModel, 'global');
    assert.equal(effA.docs['model-routing.md'].source, 'workspace');
    assert.equal(effA.docs['model-routing.md'].content, '# Workspace A Override\n');

    assert.equal(effB.effective.exclusiveLeaseEnabled, true);
    assert.equal(effB.effective.controllerCompactionThreshold, 7);
    assert.equal(effB.sourceMap.controllerCompactionThreshold, 'global');
    assert.equal(effB.docs['model-routing.md'].source, 'global');
    assert.equal(effB.docs['model-routing.md'].content, '# Global Override\n');

    // 5) Clearing single workspace override restores global inheritance
    saveWorkspaceSettings(dataDir, wsA, { overrides: { controllerCompactionThreshold: null } });
    const effACleared = resolveEffectiveSettings({ dataDir, wsReal: wsA, pluginRoot });
    assert.equal(effACleared.effective.controllerCompactionThreshold, 7);
    assert.equal(effACleared.sourceMap.controllerCompactionThreshold, 'global');

    // 6) Resetting docs and layers restores defaults cleanly
    assert.throws(
      () => saveDocOverride(dataDir, 'global', 'model-routing.md', 'x'.repeat(270 * 1024)),
      PathError
    );
    resetDocOverride(dataDir, 'workspace', 'model-routing.md', wsA);
    resetDocOverride(dataDir, 'global', 'model-routing.md');
    resetWorkspaceSettings(dataDir, wsA);
    resetGlobalSettings(dataDir);
    const pr = resetPluginSettings(dataDir);
    assert.deepEqual(pr, DEFAULT_PLUGIN_SETTINGS);
    const effAfterReset = resolveEffectiveSettings({ dataDir, wsReal: wsA, pluginRoot });
    assert.equal(effAfterReset.docs['model-routing.md'].source, 'builtin');
    assert.equal(effAfterReset.effective.controllerCompactionThreshold, DEFAULT_GLOBAL_SETTINGS.controllerCompactionThreshold);
  } finally {
    sb.cleanup();
  }
});

test('Host permission policy maps to autonomy tiers and dispatch model validator blocks forbidden tiers', () => {
  const sb = makeSandbox();
  try {
    const cfgDir = join(sb.dir, 'cfg');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, 'config.json'),
      JSON.stringify({
        userSettings: {
          permissionPreset: 'AGENT_PERMISSION_PRESET_ALWAYS_PROCEED',
          autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_AUTO',
        },
      }),
      'utf8'
    );
    const hpAlways = readHostPermissionPolicy({ env: { AGY_CONFIG_DIR: cfgDir } });
    assert.equal(hpAlways.available, true);
    assert.equal(resolveEffectiveAutonomy('inherit', hpAlways).level, 'autonomous');

    writeFileSync(
      join(cfgDir, 'config.json'),
      JSON.stringify({
        userSettings: {
          permissionPreset: 'AGENT_PERMISSION_PRESET_STRICT',
          autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_ASK',
        },
      }),
      'utf8'
    );
    const hpStrict = readHostPermissionPolicy({ env: { AGY_CONFIG_DIR: cfgDir } });
    assert.equal(resolveEffectiveAutonomy('inherit', hpStrict).level, 'strict');
    assert.equal(resolveEffectiveAutonomy('balanced', hpStrict).level, 'balanced');

    // Model guard tests
    assert.equal(validateDispatchModel('').ok, false);
    assert.equal(validateDispatchModel('flash').ok, false);
    assert.equal(validateDispatchModel('flash_lite').ok, false);
    assert.equal(validateDispatchModel('Gemini 4 Argon (High)').ok, false);
    assert.equal(validateDispatchModel('gemini-3.8-flash-high').ok, false);
    assert.equal(validateDispatchModel('Orchestrator (Carbon)').ok, true);
    assert.equal(validateDispatchModel('Orchestrator (Neon)').ok, true);
    assert.equal(validateDispatchModel('Gemini 4 Hydrogen (Medium)').ok, true);
    assert.equal(validateDispatchModel('custom-model-v1').ok, false);
    assert.equal(
      validateDispatchModel('custom-model-v1', {
        modelGuardPolicy: 'custom_allowlist',
        customAllowedModels: ['custom-model-v1'],
      }).ok,
      true
    );

    assert.equal(DEFAULT_GLOBAL_SETTINGS.l0ControllerModel, 'Gemini 4 Neon (XHigh)');
    assert.equal(DEFAULT_GLOBAL_SETTINGS.l1LightModel, 'Gemini 4 Hydrogen (XHigh)');
    assert.equal(DEFAULT_GLOBAL_SETTINGS.l2StandardModel, 'Orchestrator (Neon Extra High)');
    assert.equal(DEFAULT_GLOBAL_SETTINGS.l3DeepModel, 'Orchestrator (Carbon)');
    assert.equal(DEFAULT_GLOBAL_SETTINGS.l4IntegrationModel, 'Orchestrator (Neon Extra High)');
    assert.equal(DEFAULT_GLOBAL_SETTINGS.autoLearnMode, 'smart_proposal');
    assert.equal(validateDispatchModel('gemini-4-hydrogen-tiered-high').ok, true);
    assert.equal(validateDispatchModel('Gemini 4 Neon (XHigh)').ok, true);
    const dataDir = join(sb.dir, 'plugin_data');
    const wsA = join(sb.dir, 'wsA');
    const pluginRoot = join(process.cwd(), 'plugin');
    mkdirSync(wsA, { recursive: true });
    saveWorkspaceSettings(dataDir, wsA, { overrides: { autoLearnMode: 'off' } });
    assert.equal(resolveEffectiveSettings({ dataDir, wsReal: wsA, pluginRoot }).effective.autoLearnMode, 'off');
    resetWorkspaceSettings(dataDir, wsA);
    assert.equal(normalizeModelForAgentApi('Gemini 4 Neon (XHigh)'), 'gemini-4-neon-xhigh');
    assert.equal(normalizeModelForAgentApi('Orchestrator (Carbon)'), 'gemini-pro-orchestrator');
    assert.equal(normalizeModelForAgentApi('Orchestrator (Neon)'), 'gemini-pro-orchestrator-neon');
    assert.equal(normalizeModelForAgentApi('Gemini 4 Hydrogen (Medium)'), 'gemini-4-hydrogen-medium');
    assert.equal(normalizeModelForAgentApi('gemini-4-neon-high'), 'gemini-4-neon-high');
  } finally {
    sb.cleanup();
  }
});
