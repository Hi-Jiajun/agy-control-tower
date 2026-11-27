import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { hasCommandInPath } from '../scripts/ct-doctor.mjs';
import { checkTextHygiene, runPrecommitCheck } from '../scripts/ct-precommit-check.mjs';
import { validatePluginBundleOffline } from '../scripts/ct-validate-offline.mjs';
import { makeSandbox } from './helpers.mjs';

const REPO_ROOT = process.cwd();
const PLUGIN_DIR = join(REPO_ROOT, 'plugin');

function hasWorkingBash() {
  if (!hasCommandInPath('bash')) return false;
  const probe = spawnSync('bash', ['-c', 'echo ct_bash_ok'], { encoding: 'utf8', timeout: 3000 });
  return probe.status === 0 && (probe.stdout || '').includes('ct_bash_ok');
}

function toBashPath(p) {
  return process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
}

test('Version single source of truth & plugin package metadata hygiene', () => {
  const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const pluginJson = JSON.parse(readFileSync(join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
  const sidecarPkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'sidecars', 'tower', 'package.json'), 'utf8'));

  assert.equal(pluginJson.name, 'control-tower');
  assert.equal(rootPkg.version, pluginJson.version);
  assert.equal(sidecarPkg.version, pluginJson.version);

  const allowedKeys = new Set([
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
  for (const key of Object.keys(pluginJson)) {
    assert.ok(allowedKeys.has(key), `Unexpected plugin.json key: ${key}`);
  }
  assert.equal(existsSync(join(PLUGIN_DIR, pluginJson.logo)), true);
  assert.equal(existsSync(join(PLUGIN_DIR, 'AGENTS.md')), false);

  // Check SKILL.md frontmatter, relative links, conditional agy-fast --cli attachment & zero hardcoded ~/.gemini/config
  const skillMd = readFileSync(join(PLUGIN_DIR, 'skills', 'control-tower', 'SKILL.md'), 'utf8');
  assert.match(skillMd, /^---\r?\n[\s\S]*?name:\s*control-tower[\s\S]*?\r?\n---\r?\n/);
  assert.ok(skillMd.includes('./references/model-routing.md'));
  assert.ok(skillMd.includes('./references/templates.md'));

  const templatesMd = readFileSync(
    join(PLUGIN_DIR, 'skills', 'control-tower', 'references', 'templates.md'),
    'utf8'
  );
  const agyFastCliPath = '$HOME/.gemini/config/plugins/agy-fast/dist/mcp-server.mjs';
  assert.ok(skillMd.includes(agyFastCliPath) && skillMd.includes('--cli') && skillMd.includes('零强依赖'));
  assert.ok(templatesMd.includes(agyFastCliPath) && templatesMd.includes('--cli') && templatesMd.includes('零强依赖'));
  const sec45Match = templatesMd.match(/### 4\.5[^\r\n]*[\s\S]*?```text\r?\n([\s\S]*?)\r?\n```/);
  assert.ok(sec45Match, 'Section 4.5 conditional Swarm --cli block missing in templates.md');
  assert.equal(sec45Match[1].trim().split(/\r?\n/).length, 3);
  assert.equal(templatesMd.includes('~/.gemini/config'), false);
  assert.equal(templatesMd.replaceAll(agyFastCliPath, '').includes('.gemini/config'), false);
  assert.equal(templatesMd.includes('skills/control-tower'), false);
});

test('Official agy plugin validate --strict and isolated HOME install/list/uninstall pass', () => {
  const offline = validatePluginBundleOffline(PLUGIN_DIR);
  assert.equal(offline.ok, true, JSON.stringify(offline.findings));
  assert.equal(offline.name, 'control-tower');

  if (!hasCommandInPath('agy')) return;

  const valOut = execFileSync('agy', ['plugin', 'validate', '--strict', '--json', PLUGIN_DIR], {
    encoding: 'utf8',
  });
  const valJson = JSON.parse(valOut);
  assert.equal(valJson.name, 'control-tower');
  assert.deepEqual(valJson.findings, []);
  assert.equal(valJson.components.skills, 1);
  assert.equal(valJson.components.hooks, 4);
  assert.equal(valJson.components.sidecars, 1);
  assert.equal(valJson.components.rules, 0);

  const sb = makeSandbox();
  try {
    const fakeHome = join(sb.dir, 'home');
    mkdirSync(fakeHome, { recursive: true });
    const env = { ...process.env, HOME: fakeHome };

    execFileSync('agy', ['plugin', 'install', PLUGIN_DIR], { env, encoding: 'utf8' });
    const installedPath = join(fakeHome, '.gemini', 'config', 'plugins', 'control-tower');
    assert.equal(existsSync(join(installedPath, 'plugin.json')), true);

    const listOut = execFileSync('agy', ['plugin', 'list', '--json'], { env, encoding: 'utf8' });
    const listJson = JSON.parse(listOut);
    const items = Array.isArray(listJson) ? listJson : listJson.plugins || [];
    assert.ok(items.some((p) => p.name === 'control-tower' && p.enabled === true));

    execFileSync('agy', ['plugin', 'uninstall', 'control-tower'], { env, encoding: 'utf8' });
    assert.equal(existsSync(installedPath), false);
  } finally {
    sb.cleanup();
  }
});

test('cleanup-legacy-skill.sh and check-legacy-refs.sh enforce ownership and read-only safety', () => {
  if (!hasWorkingBash()) return;
  const sb = makeSandbox();
  try {
    const cfg = join(sb.dir, 'cfg');
    const legacyDir = join(cfg, 'skills', 'control-tower');
    mkdirSync(join(legacyDir, 'references'), { recursive: true });
    writeFileSync(join(legacyDir, 'SKILL.md'), '---\nname: control-tower\ndescription: test\n---\n', 'utf8');
    writeFileSync(join(legacyDir, 'custom.md'), 'extra', 'utf8');

    const env = { ...process.env, AGY_CONFIG_DIR: cfg };
    const cleanupScript = toBashPath(join(REPO_ROOT, 'scripts', 'cleanup-legacy-skill.sh'));

    // Blocks on extra unknown file unless --force
    const blocked = spawnSync('bash', [cleanupScript], { env, encoding: 'utf8' });
    assert.notEqual(blocked.status, 0);
    assert.equal(existsSync(join(legacyDir, 'custom.md')), true);

    const forced = spawnSync('bash', [cleanupScript, '--force'], { env, encoding: 'utf8' });
    assert.equal(forced.status, 0);
    assert.equal(existsSync(legacyDir), false);

    // check-legacy-refs.sh scans old bare refs while ignoring plugin/skills/control-tower
    const fx = join(sb.dir, 'fx');
    mkdirSync(fx, { recursive: true });
    writeFileSync(join(fx, 'old.md'), 'read ~/.gemini/config/skills/control-tower/SKILL.md\n', 'utf8');
    writeFileSync(
      join(fx, 'new.md'),
      'read ~/.gemini/config/plugins/control-tower/skills/control-tower/SKILL.md\n',
      'utf8'
    );

    const checker = toBashPath(join(REPO_ROOT, 'scripts', 'check-legacy-refs.sh'));
    const r = spawnSync('bash', [checker, '--fail-on-match', toBashPath(fx)], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('old.md') && !r.stdout.includes('new.md'));
  } finally {
    sb.cleanup();
  }
});

test('Repository hygiene: privacy sanitized, zero middle dots, zero forbidden delete literals, and pre-commit passes', () => {
  const gi = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
  assert.ok(gi.split(/\r?\n/).some((line) => line.trim() === '.agents/'));

  const SKIP = new Set(['.git', '.agents', 'node_modules', '__pycache__', 'tmp']);
  function walk(dir) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(ent.name)) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      const st = lstatSync(full);
      if (st.isSymbolicLink() || !st.isFile()) continue;
      checkTextHygiene(readFileSync(full), full);
    }
  }
  walk(REPO_ROOT);

  // Verify checkTextHygiene catches Windows user paths as well
  assert.throws(() => checkTextHygiene(Buffer.from('C:\\' + 'Us' + 'ers\\bob\\secret', 'utf8'), 'win-sample'));

  const res = runPrecommitCheck(REPO_ROOT);
  assert.equal(res.ok, true);

  const cliOut = execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'ct-precommit-check.mjs')], {
    encoding: 'utf8',
  });
  assert.ok(cliOut.includes('OK:'));
});
