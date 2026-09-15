import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  coordinateWebShutdown,
  resolveWebShutdownHardTimeoutMs,
  startWebServer,
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
    resolveWebShutdownHardTimeoutMs({ R_WEB_SHUTDOWN_HARD_TIMEOUT_MS: '5000' }),
    28_000,
  );
  assert.equal(
    resolveWebShutdownHardTimeoutMs({ R_WEB_SHUTDOWN_HARD_TIMEOUT_MS: '6000' }),
    6_000,
  );
});

test('caps the child drain before the handoff and Next cleanup reserves', () => {
  const child = new FakeChild();
  let spawnOptions;
  const env = {
    R_APP_ENV: 'production',
    R_WEB_SHUTDOWN_DRAIN_MS: '24000',
    R_WEB_SHUTDOWN_HARD_TIMEOUT_MS: '28000',
  };
  startWebServer({
    env,
    nextBin: '/next',
    loadEnv: () => undefined,
    spawnProcess: (_command, _args, options) => {
      spawnOptions = options;
      return child;
    },
  });

  assert.equal(spawnOptions.env.ROOMOTE_WEB_SHUTDOWN_MAX_DRAIN_MS, '22000');
  child.exitCode = 0;
  child.emit('close', 0, null);
});
