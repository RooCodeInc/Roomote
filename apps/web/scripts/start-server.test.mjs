import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  coordinateWebShutdown,
  resolveWebShutdownHardTimeoutMs,
  WEB_FAST_AGENT_SHUTDOWN_READY,
  WEB_FAST_AGENT_SHUTDOWN_REQUEST,
} from './start-server.mjs';

class FakeChild extends EventEmitter {
  exitCode = null;
  sent = [];
  killed = [];

  send(message) {
    this.sent.push(message);
  }

  kill(signal) {
    this.killed.push(signal);
  }
}

test('waits for Fast handoff before asking Next to shut down', () => {
  const child = new FakeChild();
  const cleanup = coordinateWebShutdown(child, 'SIGTERM', {
    hardTimeoutMs: 10_000,
  });

  assert.deepEqual(child.sent, [
    { type: WEB_FAST_AGENT_SHUTDOWN_REQUEST, signal: 'SIGTERM' },
  ]);
  assert.deepEqual(child.killed, []);

  child.emit('message', {
    type: WEB_FAST_AGENT_SHUTDOWN_READY,
    signal: 'SIGTERM',
  });
  assert.deepEqual(child.killed, ['SIGTERM']);
  cleanup();
});

test('keeps a hard shutdown deadline', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new FakeChild();
  const cleanup = coordinateWebShutdown(child, 'SIGTERM', {
    hardTimeoutMs: 6_000,
  });

  context.mock.timers.tick(1_000);
  assert.deepEqual(child.killed, ['SIGTERM']);
  context.mock.timers.tick(5_000);
  assert.deepEqual(child.killed, ['SIGTERM', 'SIGKILL']);
  cleanup();
});

test('validates the hard timeout override', () => {
  assert.equal(resolveWebShutdownHardTimeoutMs({}), 28_000);
  assert.equal(
    resolveWebShutdownHardTimeoutMs({ R_WEB_SHUTDOWN_HARD_TIMEOUT_MS: '9000' }),
    9_000,
  );
  assert.equal(
    resolveWebShutdownHardTimeoutMs({ R_WEB_SHUTDOWN_HARD_TIMEOUT_MS: '10' }),
    28_000,
  );
});
