export const OPENCODE_SLACK_HOOKS_PLUGIN_SCRIPT = `import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SILENCE_HOOK_PATH = join(CONFIG_DIR, 'roomote-opencode-slack-silence-hook.cjs');
const NODE_EXECUTABLE = process.env.ROOMOTE_NODE_EXECUTABLE || 'node';
const MAX_PENDING_TOOL_CALL_WARNINGS = 200;
const pendingToolCallWarnings = new Map();

function runHook(scriptPath, input) {
  const result = spawnSync(NODE_EXECUTABLE, [scriptPath], {
    encoding: 'utf8',
    input: JSON.stringify(input ?? {}),
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'OpenCode Slack hook failed.');
  }

  if (!result.stdout.trim()) {
    return { blocked: false };
  }

  let payload;

  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return { blocked: false };
  }

  const blocked =
    payload?.decision === 'block' ||
    payload?.continue === false ||
    Boolean(payload?.stopReason);

  return {
    blocked,
    denied: payload?.permissionDecision === 'deny',
    reason:
      payload?.reason ??
      payload?.stopReason ??
      payload?.hookSpecificOutput?.additionalContext ??
      'Slack-visible update is required before continuing.',
  };
}

function runSilenceHook(hookEventName, input, toolArgs) {
  return runHook(SILENCE_HOOK_PATH, {
    hook_event_name: hookEventName,
    threadId: input.sessionID,
    tool_name: input.tool,
    tool_args: toolArgs ?? input.args,
  });
}

function getToolCallId(input) {
  return input && typeof input.callID === 'string' && input.callID
    ? input.callID
    : undefined;
}

function appendWarning(output, reason) {
  if (!reason || !output || typeof output.output !== 'string') {
    return;
  }

  output.output = [output.output, reason]
    .filter((part) => part.trim().length > 0)
    .join('\\n\\n');
}

export const RoomoteOpenCodeSlackHooks = async () => ({
  'tool.execute.before': async (input, context) => {
    // Mostly advisory: Slack-discipline reminders are appended to the tool
    // result in tool.execute.after instead of blocking the tool call. The
    // one hard stop is a permissionDecision of 'deny' (subagent sessions
    // attempting to post to Slack), which fails the tool call outright.
    let decision;

    try {
      decision = runSilenceHook('PreToolUse', input, context?.args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        'WARN [SlackHook] PreToolUse advisory evaluation failed: ' +
          message +
          '\\n',
      );
      return;
    }

    if (decision.denied) {
      throw new Error(decision.reason);
    }

    const callId = getToolCallId(input);

    if (decision.blocked && callId) {
      if (pendingToolCallWarnings.size >= MAX_PENDING_TOOL_CALL_WARNINGS) {
        pendingToolCallWarnings.clear();
      }

      pendingToolCallWarnings.set(callId, decision.reason);
    }
  },
  'tool.execute.after': async (input, output) => {
    const callId = getToolCallId(input);
    const preToolUseWarning = callId
      ? pendingToolCallWarnings.get(callId)
      : undefined;

    if (callId) {
      pendingToolCallWarnings.delete(callId);
    }

    let decision = { blocked: false };

    try {
      decision = runSilenceHook('PostToolUse', input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        'WARN [SlackHook] PostToolUse advisory evaluation failed: ' +
          message +
          '\\n',
      );
    }

    appendWarning(
      output,
      decision.blocked ? decision.reason : preToolUseWarning,
    );
  },
});
`;
