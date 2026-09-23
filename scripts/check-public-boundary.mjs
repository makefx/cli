import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

// This repository is a thin client for the public API and MCP endpoint. The
// check is a release gate for the rules in AGENTS.md, not their only review.
const root = path.resolve(import.meta.dirname, '..');
const failures = [];

// Resolve the bundle's real input graph rather than pattern-matching imports:
// every file esbuild would bundle must be CLI source or Node built-ins.
const { metafile } = await build({
  entryPoints: [path.join(root, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  metafile: true,
  logLevel: 'silent',
});
for (const input of Object.keys(metafile.inputs)) {
  if (!path.resolve(root, input).startsWith(path.join(root, 'src') + path.sep)) {
    failures.push(`the bundle includes ${input}; the CLI bundles only its own src/`);
  }
}

const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies']) {
  if (manifest[field] !== undefined) failures.push(`package.json must not declare ${field}`);
}

// Commands a public client must not grow: raw passthrough, operator, and admin surfaces.
const bundle = await readFile(path.join(root, 'dist', 'makefx.js'), 'utf8');
for (const pattern of [/\/api\/admin\b/, /\bmakefx (?:api|admin|operator)\b/, /\bcase ['"](?:api|admin|operator)['"]/]) {
  if (pattern.test(bundle)) failures.push(`dist/makefx.js matches ${pattern}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log('Public client boundary verified');
