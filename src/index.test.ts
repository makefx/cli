import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runCli = (
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> => {
  return new Promise((resolve, reject) => {
    // Node runs the TypeScript source directly; there is no transformer to
    // load. Spawning the real entrypoint is the point of this test, so it must
    // invoke the CLI entrypoint itself.
    const child = spawn(process.execPath, [fileURLToPath(new URL('./index.ts', import.meta.url)), ...args], { cwd });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, code });
    });
  });
};

test('help command displays available commands', async () => {
  const cwd = process.cwd();
  const result = await runCli(['help'], cwd);

  assert.equal(result.code, 0, `CLI exited with code ${result.code}; stderr: ${result.stderr}`);
  assert.ok(result.stdout.includes('login'), 'Help output should include login command');
  assert.ok(result.stdout.includes('logout'), 'Help output should include logout command');
  assert.ok(result.stdout.includes('purchase create'), 'Help output should include purchase commands');
  assert.ok(result.stdout.includes('profile update'), 'Help output should include profile commands');
  assert.ok(result.stdout.includes('health'), 'Help output should include health');
  assert.ok(result.stdout.includes('space create'), 'Help output should include nested space commands');
  assert.ok(result.stdout.includes('asset get'), 'Help output should include nested asset commands');
  assert.ok(result.stdout.includes('asset update'), 'Help output should include asset mutations');
  assert.ok(result.stdout.includes('upload --space'), 'Help output should include streaming upload');
  assert.ok(result.stdout.includes('download ASSET'), 'Help output should include streaming download');
  assert.ok(result.stdout.includes('describe'), 'Help output should include describe');
  assert.ok(result.stdout.includes('unlink'), 'Help output should include link mutations');
  assert.ok(result.stdout.includes('export --space'), 'Help output should include export');
  assert.ok(result.stdout.includes('open SPACE'), 'Help output should include open');
  assert.ok(result.stdout.includes('--env production|stage|local'), 'Help should document environments');
  assert.ok(result.stdout.includes('--json'), 'Help should document JSON output');
  assert.ok(result.stdout.includes('Exit codes:'), 'Help should document exit codes');
  assert.ok(result.stdout.includes('--model image/frame'), 'Help should recommend the canonical frame model');
  assert.equal(
    result.stdout.includes('--model frame '),
    false,
    'Help should not recommend a historical model id',
  );
  assert.ok(result.stdout.includes('--ref as_video:source'), 'Help should include a create example');
  assert.ok(result.stdout.includes('--file ./frame.png'), 'Help should include an upload example');
});

test('--version and version print the version without authenticating', async () => {
  for (const args of [['--version'], ['version']]) {
    const result = await runCli(args, process.cwd());
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '0.0.0-dev\n');
  }
});

test('every top-level command exposes help without authentication', async () => {
  const commands = [
    'login',
    'logout',
    'mcp',
    'account',
    'purchase',
    'profile',
    'health',
    'spaces',
    'models',
    'estimate',
    'create',
    'upload',
    'download',
    'describe',
    'link',
    'unlink',
    'export',
    'open',
  ];
  for (const command of commands) {
    const result = await runCli([command, '--help'], process.cwd());
    assert.equal(result.code, 0, `${command}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`Usage: makefx ${command}`));
    assert.equal(result.stderr, '');
  }
});

test('transfer help is stable and does not require authentication', async () => {
  const upload = await runCli(['upload', '--help'], process.cwd());
  assert.equal(upload.code, 0);
  assert.match(upload.stdout, /Usage: makefx upload --space/);
  assert.equal(upload.stderr, '');

  const download = await runCli(['download', '--help'], process.cwd());
  assert.equal(download.code, 0);
  assert.equal(
    download.stdout.trim(),
    'Usage: makefx download ASSET --space ACCOUNT/SPACE [--out PATH] [--json]',
  );
  assert.equal(download.stderr, '');
});

test('nested help is stable and does not require authentication', async () => {
  const result = await runCli(['space', 'help'], process.cwd());

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: makefx space create/);
  assert.match(result.stdout, /Usage: makefx space get/);
  assert.match(result.stdout, /Usage: makefx space delete/);
  assert.equal(result.stderr, '');

  const command = await runCli(['asset', 'get', '--help'], process.cwd());
  assert.equal(command.code, 0);
  assert.equal(
    command.stdout.trim(),
    'Usage: makefx asset get --space ACCOUNT/SPACE --asset ID [--wait-seconds 0..60] [--json]',
  );
  assert.equal(command.stderr, '');

  const mutations = await runCli(['asset', 'help'], process.cwd());
  assert.equal(mutations.code, 0);
  assert.match(mutations.stdout, /Usage: makefx asset update/);
  assert.match(mutations.stdout, /Usage: makefx asset delete/);
  assert.equal(mutations.stderr, '');

  const purchase = await runCli(['purchase', 'help'], process.cwd());
  assert.equal(purchase.code, 0);
  assert.match(purchase.stdout, /purchase create.*--billing JSON\|@FILE/);
  assert.match(purchase.stdout, /purchase get/);
  assert.equal(purchase.stderr, '');

  const profile = await runCli(['profile', 'update', '--help'], process.cwd());
  assert.equal(profile.code, 0);
  assert.match(profile.stdout, /Usage: makefx profile update --name TEXT/);
  assert.equal(profile.stderr, '');
});

test('new MCP parity commands expose exact help without authentication', async () => {
  for (const args of [
    ['purchase', 'create', '--help'],
    ['purchase', 'get', '--help'],
    ['profile', 'get', '--help'],
    ['profile', 'update', '--help'],
    ['health', '--help'],
  ]) {
    const result = await runCli(args, process.cwd());
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`Usage: makefx ${args.slice(0, -1).join(' ')}`));
    assert.equal(result.stderr, '');
  }
});

test('space visibility commands and nested help work without authentication', async () => {
  for (const command of ['publish', 'unpublish']) {
    const direct = await runCli(['space', command, '--help'], process.cwd());
    assert.equal(direct.code, 0, direct.stderr);
    assert.match(direct.stdout, new RegExp(`Usage: makefx space ${command} --space ACCOUNT/SPACE`));
    assert.equal(direct.stderr, '');
  }

  const nested = await runCli(['space', 'help'], process.cwd());
  assert.equal(nested.code, 0, nested.stderr);
  assert.match(nested.stdout, /space publish/);
  assert.match(nested.stdout, /space unpublish/);
  assert.equal(nested.stderr, '');
});

test('new command usage errors exit 2 before authentication and runtime failures exit 1', async () => {
  const invalid = await runCli(
    ['purchase', 'create', '--account', 'acme', '--product', 'eur20', '--request-id', 'one', '--card', 'x'],
    process.cwd(),
  );
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /Unknown option --card/);
  assert.doesNotMatch(invalid.stderr, /Not logged in/);

  const failure = await runCli(['health', '--env', 'not-configured'], process.cwd());
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /Not logged in/);
});

test('invalid nested command usage exits 2', async () => {
  const result = await runCli(['asset', 'restore'], process.cwd());

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown asset command: restore/);
});

test('invalid create options and positionals exit 2 before authentication', async () => {
  for (const args of [
    ['create', '--promt', 'mistyped'],
    ['create', 'unexpected', '--space', 'acme/flight', '--kind', 'image', '--model', 'image/frame'],
    ['create', '--space', 'acme/flight', '--kind', 'image', '--model', 'image/frame', '--wait', 'unexpected'],
  ]) {
    const result = await runCli(args, process.cwd());
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Usage: makefx create/);
    assert.doesNotMatch(result.stderr, /Not logged in/);
  }
});
