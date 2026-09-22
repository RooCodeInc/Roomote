/**
 * OpenCode plugin: before a tool call that reports to a person or ships the
 * work, ask the sandbox server to run the completion check. A denial fails
 * the tool call with the reasons, which the agent reads as the tool result.
 * Everything else, including any failure to reach the server, lets the call
 * through. Written into the OpenCode plugins directory by agent-home.
 */
export const OPENCODE_COMPLETION_GATE_PLUGIN_SCRIPT = `const SANDBOX_SERVER_URL =
  process.env.ROOMOTE_SANDBOX_SERVER_URL || 'http://127.0.0.1:4200';
const CHECK_TIMEOUT_MS = 20_000;
// A cheap pre-filter; the sandbox server makes the real classification.
const CANDIDATE_TOOL = /report_to_parent_session|send_chat_reply|send_chat_message|manage_source_control|^(bash|shell)$/;
const CANDIDATE_COMMAND = /\\bgit\\b[^|;&\\n]*\\bpush\\b|\\bgh\\s+pr\\b|\\bglab\\s+mr\\b/;

function isCandidate(tool, args) {
  if (!CANDIDATE_TOOL.test(tool)) {
    return false;
  }

  if (tool === 'bash' || tool === 'shell') {
    return CANDIDATE_COMMAND.test(String(args?.command ?? ''));
  }

  return true;
}

async function checkCompletionBeforeTool(tool, args) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(
      SANDBOX_SERVER_URL + '/trpc/commands.checkCompletionBeforeTool',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + process.env.ROOMOTE_CLOUD_TOKEN,
        },
        // superjson envelope, as the sandbox server's tRPC expects.
        body: JSON.stringify({ json: { tool, args } }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      return { allowed: true };
    }

    const body = await response.json();
    return body?.result?.data?.json ?? { allowed: true };
  } finally {
    clearTimeout(timer);
  }
}

export const RoomoteOpenCodeCompletionGate = async () => ({
  'tool.execute.before': async (input, context) => {
    if (process.env.ROOMOTE_COMPLETION_GATE !== 'true') {
      return;
    }

    const tool = typeof input?.tool === 'string' ? input.tool : '';
    const args = context?.args ?? input?.args;

    if (!isCandidate(tool, args)) {
      return;
    }

    let decision;

    try {
      decision = await checkCompletionBeforeTool(tool, args);
    } catch (error) {
      process.stderr.write(
        'WARN [CompletionGate] check before ' +
          tool +
          ' failed; allowing the call: ' +
          (error instanceof Error ? error.message : String(error)) +
          '\\n',
      );
      return;
    }

    if (decision && decision.allowed === false && decision.reason) {
      throw new Error(decision.reason);
    }
  },
});
`;
