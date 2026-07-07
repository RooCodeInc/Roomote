import { Agent, type Dispatcher } from 'undici';

// Undici applies a 300s body timeout by default. Our long-lived proxy routes
// can legitimately go quiet longer than that, so rely on caller disconnects
// rather than a transport-level body timeout for these requests.
//
// A single Agent is shared across OpenAI and MCP proxy traffic. If connection
// pool limits or keep-alive settings ever need to differ between the two,
// split into per-surface dispatchers.
const LONG_LIVED_STREAM_DISPATCHER: Dispatcher = new Agent({
  bodyTimeout: 0,
});

function withLongLivedStreamDispatcher<T extends RequestInit>(
  init: T,
): T & { dispatcher: Dispatcher } {
  return {
    ...init,
    dispatcher: LONG_LIVED_STREAM_DISPATCHER,
  };
}

export function fetchWithLongLivedStreamDispatcher<T extends RequestInit>(
  input: RequestInfo | URL,
  init: T,
): Promise<Response> {
  return fetch(input, withLongLivedStreamDispatcher(init));
}
