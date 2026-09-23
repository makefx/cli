import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const outfile = new URL('../dist/makefx.js', import.meta.url);

await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('../dist', import.meta.url), { recursive: true });

await build({
  entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
  outfile: outfile.pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
});

await chmod(outfile, 0o755);
console.log(`Built makefx ${packageJson.version}`);
