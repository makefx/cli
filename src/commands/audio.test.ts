import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs } from '../lib/utils.ts';
import type { ToolClient } from '../lib/tool-client.ts';
import { handleAudioCommand } from './audio.ts';

test('audio align uses the public tools and waits on the admitted durable job', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let polls = 0;
  const client: ToolClient = {
    async call(name, args) {
      calls.push({ name, args });
      if (name === 'align_audio') {
        return { alignment_job: { alignment_job_id: 'al-1', status: 'queued' } };
      }
      polls += 1;
      return {
        asset_id: 'as-audio',
        alignment_job: { alignment_job_id: 'al-1', status: polls === 1 ? 'running' : 'completed' },
        word_timings: polls === 1 ? null : { schema_version: 1, text: 'Hello', words: [] },
      };
    },
  };
  const output: string[] = [];
  await handleAudioCommand(
    'audio align',
    parseArgs([
      'as-audio',
      '--space',
      'acme/voice',
      'Hello',
      '--request-id',
      'request-1',
      '--wait',
      '--json',
    ]),
    { client: async () => client, write: (text) => output.push(text), id: () => 'unused' },
  );
  assert.deepEqual(
    calls.map(({ name }) => name),
    ['align_audio', 'get_audio_word_timings', 'get_audio_word_timings'],
  );
  assert.deepEqual(calls[0]?.args, {
    space_id: 'acme/voice',
    asset_id: 'as-audio',
    request_id: 'request-1',
    text: 'Hello',
  });
  assert.equal(JSON.parse(output[0] ?? '{}').alignment_job.status, 'completed');
});

test('audio timings emits only the current canonical document in stdout JSON mode', async () => {
  const timing = {
    schema_version: 1,
    text: 'Hello',
    words: [{ text: 'Hello', start_ms: 0, end_ms: 200, start_char: 0, end_char: 5 }],
    provenance: { method: 'forced_alignment' },
  };
  const output: string[] = [];
  await handleAudioCommand('audio timings', parseArgs(['as-audio', '--space', 'acme/voice', '--json']), {
    client: async () => ({ call: async () => ({ asset_id: 'as-audio', word_timings: timing }) }),
    write: (text) => output.push(text),
    id: () => 'unused',
  });
  assert.deepEqual(JSON.parse(output[0] ?? '{}'), timing);
});
