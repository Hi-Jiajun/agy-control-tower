#!/usr/bin/env node
/**
 * Zero-dependency offline strict validator for the ./plugin/ bundle.
 * Enables full manifest, hooks, sidecar, skill frontmatter, and boundary checks
 * on public CI runners and contributor machines even when the `agy` CLI is absent.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const ALLOWED_PLUGIN_KEYS = new Set([
  'name',
  'displayName',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'logo',
  'suggestedPrompts',
  'disabled',
]);

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const EXPECTED_HOOK_EVENTS = ['SessionStart', 'PreInvocation', 'PreToolUse', 'Stop'];

export function validatePluginBundleOffline(pluginDir = join(REPO_ROOT, 'plugin')) {
  const absPlugin = resolve(pluginDir);
  const findings = [];
  const addFinding = (code, message) => findings.push({ code, message });

  const pjPath = join(absPlugin, 'plugin.json');
  if (!existsSync(pjPath)) {
    addFinding('missing_manifest', 'plugin/plugin.json does not exist');
    return { ok: false, name: '', version: '', findings };
  }

  let pj;
  try {
    pj = JSON.parse(readFileSync(pjPath, 'utf8'));
  } catch (err) {
    addFinding('invalid_manifest_json', `Failed to parse plugin.json: ${err?.message || err}`);
    return { ok: false, name: '', version: '', findings };
  }

  for (const k of Object.keys(pj)) {
    if (!ALLOWED_PLUGIN_KEYS.has(k)) {
      addFinding('unknown_manifest_key', `Disallowed top-level key in plugin.json: ${k}`);
    }
  }

  if (typeof pj.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(pj.name)) {
    addFinding('invalid_name', 'plugin.json name must be lowercase kebab-case');
  }
  if (typeof pj.description !== 'string' || !pj.description.trim()) {
    addFinding('invalid_description', 'plugin.json description must be non-empty');
  }
  if (typeof pj.version !== 'string' || !SEMVER_RE.test(pj.version)) {
    addFinding('invalid_version', `plugin.json version must be valid SemVer, got: ${pj.version}`);
  }
  if (pj.logo !== undefined) {
    if (
      typeof pj.logo !== 'string' ||
      pj.logo.startsWith('/') ||
      pj.logo.includes('..') ||
      !/\.(?:svg|png|jpe?g|webp)$/i.test(pj.logo) ||
      !existsSync(join(absPlugin, pj.logo))
    ) {
      addFinding('invalid_logo', `plugin.json logo missing or invalid: ${pj.logo}`);
    }
  }
  if (pj.suggestedPrompts !== undefined) {
    if (
      !Array.isArray(pj.suggestedPrompts) ||
      pj.suggestedPrompts.length > 3 ||
      pj.suggestedPrompts.some((s) => typeof s !== 'string' || !s.trim())
    ) {
      addFinding('invalid_suggested_prompts', 'suggestedPrompts must be 1..3 non-empty strings');
    }
  }
  for (const urlField of ['homepage', 'repository']) {
    const val = pj[urlField];
    if (val !== undefined) {
      const urlStr = typeof val === 'string' ? val : val?.url;
      if (typeof urlStr !== 'string' || !urlStr.startsWith('https://')) {
        addFinding(`invalid_${urlField}`, `${urlField} must be an https:// URL`);
      }
    }
  }

  // Purity boundaries: zero rules/AGENTS.md, zero workspace dev files leaked into ./plugin/
  if (existsSync(join(absPlugin, 'rules'))) {
    addFinding('unexpected_rules_dir', 'plugin/rules must not exist (zero always-on global rules invariant)');
  }
  for (const forbidden of ['AGENTS.md', 'node_modules', 'tests']) {
    if (existsSync(join(absPlugin, forbidden))) {
      addFinding('impure_bundle', `Forbidden development artifact inside plugin/: ${forbidden}`);
    }
  }

  // Hooks validation
  const hooksPath = join(absPlugin, 'hooks.json');
  if (!existsSync(hooksPath)) {
    addFinding('missing_hooks', 'plugin/hooks.json is missing');
  } else {
    try {
      const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
      const seenEvents = new Set();
      for (const group of Object.values(hooks)) {
        if (!group || typeof group !== 'object') continue;
        for (const [evName, entries] of Object.entries(group)) {
          seenEvents.add(evName);
          if (!Array.isArray(entries) || entries.length === 0) {
            addFinding('invalid_hook_entries', `Hook event ${evName} must be a non-empty array`);
            continue;
          }
          for (const item of entries) {
            const cmds = Array.isArray(item?.hooks) ? item.hooks : [item];
            for (const c of cmds) {
              if (c?.type !== 'command' || typeof c.command !== 'string' || !c.command.trim()) {
                addFinding('invalid_hook_command', `Invalid command hook under ${evName}`);
                continue;
              }
              const relMatch = c.command.match(/\.\/([^\s"']+)/);
              if (relMatch && !existsSync(join(absPlugin, relMatch[1]))) {
                addFinding('missing_hook_script', `Hook script not found: ${relMatch[1]}`);
              }
            }
          }
        }
      }
      for (const reqEv of EXPECTED_HOOK_EVENTS) {
        if (!seenEvents.has(reqEv)) {
          addFinding('missing_hook_event', `Expected hook event missing: ${reqEv}`);
        }
      }
    } catch (err) {
      addFinding('invalid_hooks_json', `Failed to parse hooks.json: ${err?.message || err}`);
    }
  }

  // Sidecar validation
  const sidecarDir = join(absPlugin, 'sidecars', 'tower');
  const sidecarJsonPath = join(sidecarDir, 'sidecar.json');
  if (!existsSync(sidecarJsonPath)) {
    addFinding('missing_sidecar', 'plugin/sidecars/tower/sidecar.json is missing');
  } else {
    try {
      const sc = JSON.parse(readFileSync(sidecarJsonPath, 'utf8'));
      if (sc.command !== 'node' || !Array.isArray(sc.args) || !sc.args[0]) {
        addFinding('invalid_sidecar_cmd', 'sidecar.json must launch node with entry script');
      } else if (!existsSync(join(sidecarDir, sc.args[0]))) {
        addFinding('missing_sidecar_entry', `Sidecar entry script missing: ${sc.args[0]}`);
      }
      if (sc.has_web_ui !== true || !Array.isArray(sc.ui_config?.views) || sc.ui_config.views.length === 0) {
        addFinding('invalid_sidecar_ui', 'sidecar.json must declare Aux Pane UI view');
      }
    } catch (err) {
      addFinding('invalid_sidecar_json', `Failed to parse sidecar.json: ${err?.message || err}`);
    }
  }

  // Skill validation
  const skillDir = join(absPlugin, 'skills', 'control-tower');
  const skillMdPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMdPath)) {
    addFinding('missing_skill', 'plugin/skills/control-tower/SKILL.md is missing');
  } else {
    const md = readFileSync(skillMdPath, 'utf8');
    const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (!fm) {
      addFinding('missing_skill_frontmatter', 'SKILL.md must begin with YAML frontmatter');
    } else {
      if (!/^name:\s*control-tower\s*$/m.test(fm[1])) {
        addFinding('invalid_skill_name', 'SKILL.md frontmatter name must be control-tower');
      }
      if (!/^description:\s*\S+/m.test(fm[1])) {
        addFinding('invalid_skill_desc', 'SKILL.md frontmatter description must be non-empty');
      }
    }
    for (const m of md.matchAll(/\]\((\.\/[^)#\s]+)\)/g)) {
      const relTarget = m[1];
      if (!existsSync(join(skillDir, relTarget))) {
        addFinding('broken_skill_link', `Broken relative reference in SKILL.md: ${relTarget}`);
      }
    }
  }

  // Ensure no empty directories or stray backup files inside plugin/
  function scanStray(dir) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.endsWith('.bak') || ent.name.startsWith('.tmp')) {
        addFinding('stray_temp_file', `Stray temporary file in plugin/: ${join(dir, ent.name)}`);
      }
      if (ent.isDirectory()) scanStray(join(dir, ent.name));
    }
  }
  scanStray(absPlugin);

  return {
    ok: findings.length === 0,
    name: pj.name || '',
    version: pj.version || '',
    findings,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const jsonMode = process.argv.includes('--json');
  const targetArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const res = validatePluginBundleOffline(targetArg ? resolve(targetArg) : join(REPO_ROOT, 'plugin'));
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  } else if (res.ok) {
    console.log(`OK: offline strict plugin validation passed (${res.name} v${res.version})`);
  } else {
    for (const f of res.findings) {
      console.error(`FAIL [${f.code}]: ${f.message}`);
    }
  }
  process.exit(res.ok ? 0 : 1);
}
