import process from 'node:process';

const REQUEST = 'roomote:web-fast-agent-shutdown';
const READY = 'roomote:web-fast-agent-shutdown-ready';
const HANDLER = Symbol.for('roomote.web-fast-agent-shutdown-handler');
const HANDLER_READY_TIMEOUT_MS = 5_000;

async function resolveShutdownHandler() {
  const deadline = Date.now() + HANDLER_READY_TIMEOUT_MS;
  while (typeof globalThis[HANDLER] !== 'function' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return globalThis[HANDLER];
}

process.on('message', async (message) => {
  if (
    message?.type !== REQUEST ||
    (message.signal !== 'SIGTERM' && message.signal !== 'SIGINT')
  ) {
    return;
  }
  const handler = await resolveShutdownHandler();
  if (typeof handler !== 'function') {
    console.error('[web] Fast shutdown handler was not registered in time.');
    return;
  }
  await handler(message.signal);
  process.send?.({ type: READY, signal: message.signal });
});
