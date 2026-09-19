const READ_ONLY_CUA_TOOLS = new Set([
  'check_for_update',
  'clipboard_read',
  'get_browser_state',
  'get_desktop_state',
  'get_session_state',
  'get_window_state',
  'history_query',
  'history_status',
  'list_apps',
  'list_recordings',
  'list_windows',
  'recording_status',
  'verify_state',
]);

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown };
};

type HumanControlState = 'agent' | 'human' | 'unavailable';

export async function readHumanControlState(
  metricsUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HumanControlState> {
  try {
    const response = await fetchImpl(metricsUrl, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return 'unavailable';

    const body = (await response.json()) as { human_driving?: unknown };
    if (body.human_driving === true) return 'human';
    if (body.human_driving === false) return 'agent';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export async function guardCuaDriverRequest(
  line: string,
  readState: () => Promise<HumanControlState>,
): Promise<{ forward: true } | { forward: false; response: string }> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return { forward: true };
  }

  if (request.method !== 'tools/call') return { forward: true };

  const toolName = request.params?.name;
  if (typeof toolName !== 'string' || READ_ONLY_CUA_TOOLS.has(toolName)) {
    return { forward: true };
  }

  const state = await readState();
  if (state === 'agent') return { forward: true };

  const message =
    state === 'human'
      ? 'A person is using the Shared Desktop, so this computer-use action was not run. Observation tools remain available; retry after control returns to the agent.'
      : 'Shared Desktop handoff state is unavailable, so this computer-use action was not run. Observation tools remain available; retry after the desktop service recovers.';

  return {
    forward: false,
    response: JSON.stringify({
      jsonrpc: '2.0',
      id: request.id ?? null,
      result: {
        content: [{ type: 'text', text: message }],
        isError: true,
      },
    }),
  };
}
