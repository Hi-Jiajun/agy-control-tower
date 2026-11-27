import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join, posix as posixPath } from 'node:path';

export const BUNDLE_ENTRY_FILES = Object.freeze([
  'ui-logic.mjs',
  'views/overview.mjs',
  'views/roadmap.mjs',
  'views/sessions.mjs',
  'views/settings.mjs',
  'app.js',
]);

const BUNDLE_ENTRY_SET = new Set(BUNDLE_ENTRY_FILES);

const IMPORT_STMT_RE = /^[ \t]*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?[ \t]*\r?$/gm;
const EXPORT_FN_RE = /^export\s+(async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
const EXPORT_VAR_RE = /^export\s+(const|let|var|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
const RESIDUAL_ESM_RE = /^[ \t]*(?:import|export)(?:\s+|\s*[{*])/m;

/** Return integer mtimeMs stamp for cache-busting query strings. */
export function computeAssetStamp(filePath) {
  try {
    return String(Math.floor(statSync(filePath).mtimeMs));
  } catch {
    return '0';
  }
}

/** Build a lightweight mtime+size signature across all frontend bundle sources. */
export function computeBundleSignature(towerDir) {
  return BUNDLE_ENTRY_FILES.map((rel) => {
    try {
      const st = statSync(join(towerDir, rel));
      return `${rel}:${Math.floor(st.mtimeMs)}:${st.size}`;
    } catch {
      return `${rel}:missing`;
    }
  }).join('|');
}

function resolveModuleSpecifier(relFile, specifier) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    throw new Error(`Unsupported non-relative import "${specifier}" in ${relFile}`);
  }
  const baseDir = posixPath.dirname(relFile);
  const depKey = posixPath.normalize(baseDir === '.' ? specifier : posixPath.join(baseDir, specifier));
  if (!BUNDLE_ENTRY_SET.has(depKey)) {
    throw new Error(`Unknown frontend module import "${specifier}" (resolved "${depKey}") in ${relFile}`);
  }
  const depIdx = BUNDLE_ENTRY_FILES.indexOf(depKey);
  const selfIdx = BUNDLE_ENTRY_FILES.indexOf(relFile);
  if (depIdx < 0 || (selfIdx >= 0 && depIdx >= selfIdx)) {
    throw new Error(`Invalid module load order: ${relFile} cannot import later/self module ${depKey}`);
  }
  return depKey;
}

function transformBindingsList(rawBindings) {
  return rawBindings
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const asMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(item);
      if (asMatch) return `${asMatch[1]}: ${asMatch[2]}`;
      return item;
    })
    .join(', ');
}

function transformSingleModule(relFile, source) {
  const exportedNames = [];
  const seenExports = new Set();
  const addExport = (name) => {
    if (!seenExports.has(name)) {
      seenExports.add(name);
      exportedNames.push(name);
    }
  };

  let transformed = String(source).replace(IMPORT_STMT_RE, (_m, rawBindings, specifier) => {
    const depKey = resolveModuleSpecifier(relFile, specifier);
    const bindings = transformBindingsList(rawBindings);
    return bindings ? `const { ${bindings} } = __ctModules[${JSON.stringify(depKey)}];` : '';
  });

  transformed = transformed.replace(EXPORT_FN_RE, (_m, asyncKw, name) => {
    addExport(name);
    return `${asyncKw || ''}function ${name}`;
  });

  transformed = transformed.replace(EXPORT_VAR_RE, (_m, kind, name) => {
    addExport(name);
    return `${kind} ${name}`;
  });

  if (RESIDUAL_ESM_RE.test(transformed)) {
    throw new Error(`Residual unsupported ESM import/export syntax remained in ${relFile}`);
  }

  return [
    `  __ctModules[${JSON.stringify(relFile)}] = (function () {`,
    transformed,
    `    return { ${exportedNames.join(', ')} };`,
    `  })();`,
  ].join('\n');
}

/** Compile modular frontend ESM files into one zero-dependency classic IIFE bundle. */
export function buildClassicAppBundle(towerDir) {
  const sig = computeBundleSignature(towerDir);
  const chunks = BUNDLE_ENTRY_FILES.map((relFile) => {
    const src = readFileSync(join(towerDir, relFile), 'utf8');
    return transformSingleModule(relFile, src);
  });

  const code = [
    '(function () {',
    "  'use strict';",
    '  const __ctModules = Object.create(null);',
    chunks.join('\n\n'),
    '})();',
    '',
  ].join('\n');

  const stamp = createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 12);
  return { code, stamp, sig };
}
