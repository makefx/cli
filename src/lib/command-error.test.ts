import assert from 'node:assert/strict';
import test from 'node:test';
import { reportCommandError } from './command-error.ts';
import { CliUsageError, ToolCallError } from './errors.ts';

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    output: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

test('reports usage errors with exit status 2', () => {
  const captured = capture();

  assert.equal(reportCommandError(new CliUsageError('--count is invalid.'), false, captured.output), 2);
  assert.deepEqual(captured.stdout, []);
  assert.deepEqual(captured.stderr, ['Error: --count is invalid.\n']);
});

test('reports tool errors with structured JSON, code, and top-up URL', () => {
  const captured = capture();
  const structuredContent = {
    code: 'insufficient_credits',
    message: 'More credits are required.',
    retryable: false,
    details: { topup_url: 'https://makefx.app/settings/billing' },
  };

  assert.equal(
    reportCommandError(new ToolCallError(structuredContent, 'The tool call failed.'), true, captured.output),
    1,
  );
  assert.deepEqual(captured.stdout, [`${JSON.stringify(structuredContent)}\n`]);
  assert.deepEqual(captured.stderr, [
    'insufficient_credits: More credits are required.\n',
    'Top up: https://makefx.app/settings/billing\n',
  ]);
});
