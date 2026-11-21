import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { makeSandbox } from './helpers.mjs';

const REPO_ROOT = process.cwd();
const PLUGIN_DIR = join(REPO_ROOT, 'plugin');

function commandExists(cmd) {
  const res = spawnSync('which', [cmd], { encoding: 'utf8' });
  return res.status === 0;
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

  // Check SKILL.md frontmatter & relative links & zero hardcoded ~/.gemini/config in templates
  const skillMd = readFileSync(join(PLUGIN_DIR, 'skills', 'control-tower', 'SKILL.md'), 'utf8');
  assert.match(skillMd, /^---\n[\s\S]*?name:\s*control-tower[\s\S]*?\n---\n/);
  assert.ok(skillMd.includes('./references/model-routing.md'));
  assert.ok(skillMd.includes('./references/templates.md'));

  const templatesMd = readFileSync(
    join(PLUGIN_DIR, 'skills', 'control-tower', 'references', 'templates.md'),
    'utf8'
  );
  assert.equal(templatesMd.includes('.gemini/config'), false);
  assert.equal(templatesMd.includes('skills/control-tower'), false);
});

test('Official agy plugin validate --strict and isolated HOME install/list/uninstall pass', () => {
  if (!commandExists('agy')) return;

  const valOut = execFileSync('agy', ['plugin', 'validate', '--strict', '--json', PLUGIN_DIR], {
    encoding: 'utf8',
  });
  const valJson = JSON.parse(valOut);
  assert.equal(valJson.name, 'control-tower');
  assert.deepEqual(valJson.findings, []);
  assert.equal(valJson.components.skills, 1);
  assert.equal(valJson.components.hooks, 2);
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
  const sb = makeSandbox();
  try {
    const cfg = join(sb.dir, 'cfg');
    const legacyDir = join(cfg, 'skills', 'control-tower');
    mkdirSync(join(legacyDir, 'references'), { recursive: true });
    writeFileSync(join(legacyDir, 'SKILL.md'), '---\nname: control-tower\ndescription: test\n---\n', 'utf8');
    writeFileSync(join(legacyDir, 'custom.md'), 'extra', 'utf8');

    const env = { ...process.env, AGY_CONFIG_DIR: cfg };
    const cleanupScript = join(REPO_ROOT, 'scripts', 'cleanup-legacy-skill.sh');

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

    const checker = join(REPO_ROOT, 'scripts', 'check-legacy-refs.sh');
    const r = spawnSync('bash', [checker, '--fail-on-match', fx], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('old.md') && !r.stdout.includes('new.md'));
  } finally {
    sb.cleanup();
  }
});

test('Repository hygiene: privacy sanitized, zero middle dots, zero forbidden delete literals, and pre-commit passes', () => {
  const gi = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
  assert.ok(gi.split(/\r?\n/).some((line) => line.trim() === '.agents/'));

  const forbHome = '/' + 'home' + '/';
  const forbUsers = '/' + 'Users' + '/';
  const forbIp = '192.' + '168.';
  const forbDot = String.fromCharCode(0x00b7);
  const forbRm1 = 'rm ' + '-rf';
  const forbRm2 = 'rm ' + '-fr';
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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
      const buf = readFileSync(full);
      if (buf.includes(0)) continue;
      const txt = buf.toString('utf8');
      assert.equal(txt.includes(forbHome), false, `Personal home path in ${full}`);
      assert.equal(txt.includes(forbUsers), false, `Personal Users path in ${full}`);
      assert.equal(txt.includes(forbIp), false, `Private IP in ${full}`);
      assert.equal(uuidRe.test(txt), false, `Static UUID in ${full}`);
      assert.equal(txt.includes(forbDot), false, `Middle dot in ${full}`);
      assert.equal(txt.includes(forbRm1) || txt.includes(forbRm2), false, `Forbidden delete literal in ${full}`);
    }
  }
  walk(REPO_ROOT);

  const preCommit = execFileSync('bash', [join(REPO_ROOT, 'scripts', 'git-hooks', 'pre-commit')], {
    encoding: 'utf8',
  });
  assert.ok(preCommit.includes('OK:'));
});
