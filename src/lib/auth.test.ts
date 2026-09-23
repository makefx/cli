import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import { waitForAuthorizationCode } from './auth.ts';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function callback(port: number, query: string): Promise<{ status: number; body: string }> {
  // The listener starts asynchronously; retry briefly until it accepts.
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/callback?${query}`);
      return { status: response.status, body: await response.text() };
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

test('a callback without this login state neither ends the login nor renders its input', async () => {
  const port = await freePort();
  const login = waitForAuthorizationCode(port, 'expected-state');

  const foreignError = await callback(port, 'error=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
  assert.equal(foreignError.status, 400);
  assert.doesNotMatch(foreignError.body, /<script>/);
  const wrongState = await callback(port, 'code=stolen&state=other');
  assert.equal(wrongState.status, 400);

  const accepted = await callback(port, 'code=real-code&state=expected-state');
  assert.equal(accepted.status, 200);
  assert.deepEqual(await login, { code: 'real-code' });
});

test('an error for this login ends it, with the error escaped on the page', async () => {
  const port = await freePort();
  const login = waitForAuthorizationCode(port, 'expected-state');
  const outcome = assert.rejects(login, /OAuth error: access_denied - <b>no<\/b>/);

  const denied = await callback(port, 'error=access_denied&error_description=%3Cb%3Eno%3C%2Fb%3E&state=expected-state');
  assert.equal(denied.status, 400);
  assert.match(denied.body, /&#60;b&#62;no&#60;\/b&#62;/);
  assert.doesNotMatch(denied.body, /<b>no<\/b>/);
  await outcome;
});
