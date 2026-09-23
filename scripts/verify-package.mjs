import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const root = path.resolve(import.meta.dirname, '..');
const sourceManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'makefx-package-'));
const packed = path.join(temporary, 'packed');
const consumer = path.join(temporary, 'consumer');
const configRoot = path.join(temporary, 'config');

let call;
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  call = JSON.parse(body);
  assert.equal(request.url, '/mcp');
  assert.equal(request.headers.authorization, 'Bearer package-token');
  response.setHeader('content-type', 'application/json');
  response.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: call.id,
      result: {
        content: [{ type: 'text', text: 'One space' }],
        structuredContent: {
          spaces: [{ space_id: 'acme/salt', web_url: 'https://makefx.app/s/acme/salt' }],
        },
      },
    }),
  );
});

try {
  await Promise.all([
    mkdir(packed),
    mkdir(consumer),
    mkdir(path.join(configRoot, 'makefx-cli'), { recursive: true }),
  ]);
  // The build is checked separately; packing must not rebuild what was checked.
  const pack = await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packed], {
    cwd: root,
  });
  assert.equal(pack.code, 0, pack.stderr);
  const [{ filename, files }] = JSON.parse(pack.stdout);
  assert.deepEqual(files.map((file) => file.path).sort(), [
    'LICENSE',
    'NOTICE',
    'README.md',
    'TRADEMARKS.md',
    'dist/makefx.js',
    'package.json',
  ]);
  const tarball = path.join(packed, filename);

  const install = await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
    cwd: consumer,
  });
  assert.equal(install.code, 0, install.stderr);

  const binary = path.join(
    consumer,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'makefx.cmd' : 'makefx',
  );
  const installedPackage = path.join(consumer, 'node_modules', 'makefx');
  const installedManifest = JSON.parse(await readFile(path.join(installedPackage, 'package.json'), 'utf8'));
  const readme = await readFile(path.join(installedPackage, 'README.md'), 'utf8');
  assert.equal(installedManifest.version, sourceManifest.version);
  assert.equal(installedManifest.license, 'Apache-2.0');
  assert.equal(installedManifest.homepage, 'https://makefx.app/docs/cli');
  assert.equal(installedManifest.repository.url, 'git+https://github.com/makefx/cli.git');
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies']) {
    assert.equal(installedManifest[field], undefined, `the published CLI must not declare ${field}`);
  }
  assert.match(readme, /npm install -g makefx/);
  assert.match(readme, /space create\|get\|update\|delete/);
  assert.match(readme, /space publish\|unpublish/);
  assert.match(readme, /audio timings/);
  assert.doesNotMatch(readme, /pnpm run cli/);

  const version = await run(binary, ['--version'], { cwd: consumer });
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout, `${sourceManifest.version}\n`);

  const help = await run(binary, ['--help'], { cwd: consumer });
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /Usage: makefx <command>/);
  assert.match(help.stdout, /export --space/);
  assert.match(help.stdout, /open SPACE/);

  const packageEnv = { ...process.env, XDG_CONFIG_HOME: configRoot };
  const launchers = [
    { executable: binary, args: [], hint: 'makefx' },
    { executable: 'npx', args: ['makefx'], hint: 'npx makefx' },
  ];
  for (const launcher of launchers) {
    for (const command of [['spaces'], ['mcp']]) {
      const missing = await run(launcher.executable, [...launcher.args, ...command, '--env', 'missing'], {
        cwd: consumer,
        env: packageEnv,
      });
      assert.equal(missing.code, 1);
      assert.equal(missing.stdout, '');
      assert.ok(missing.stderr.includes(`Run: ${launcher.hint} login --env missing`));
      assert.doesNotMatch(missing.stderr, /pnpm run cli/);
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const now = Date.now();
  await writeFile(
    path.join(configRoot, 'makefx-cli', 'config.json'),
    JSON.stringify({
      configs: {
        package: {
          environment: 'package',
          baseUrl: `http://127.0.0.1:${address.port}`,
          clientId: 'cli',
          token: { accessToken: 'package-token', issuedAt: now, expiresAt: now + 3_600_000 },
          user: null,
          updatedAt: new Date(now).toISOString(),
        },
        expired: {
          environment: 'expired',
          baseUrl: `http://127.0.0.1:${address.port}`,
          clientId: 'cli',
          token: { accessToken: 'expired-token', issuedAt: now - 7_200_000, expiresAt: now - 3_600_000 },
          user: null,
          updatedAt: new Date(now).toISOString(),
        },
      },
    }),
  );

  for (const launcher of launchers) {
    for (const command of [['spaces'], ['mcp']]) {
      const expired = await run(launcher.executable, [...launcher.args, ...command, '--env', 'expired'], {
        cwd: consumer,
        env: packageEnv,
      });
      assert.equal(expired.code, 1);
      assert.equal(expired.stdout, '');
      assert.ok(expired.stderr.includes(`Run: ${launcher.hint} login --env expired`));
      assert.doesNotMatch(expired.stderr, /pnpm run cli/);
    }
  }

  const tool = await run(binary, ['spaces', '--env', 'package', '--json'], {
    cwd: consumer,
    env: packageEnv,
  });
  assert.equal(tool.code, 0, tool.stderr);
  assert.deepEqual(JSON.parse(tool.stdout), {
    spaces: [{ space_id: 'acme/salt', web_url: 'https://makefx.app/s/acme/salt' }],
  });
  assert.equal(call.method, 'tools/call');
  assert.equal(call.params.name, 'list_spaces');
  assert.deepEqual(call.params.arguments, {});

  console.log(`Verified makefx ${sourceManifest.version}: packed contents, help, sign-in hints, and an authenticated tool call from a clean install.`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
