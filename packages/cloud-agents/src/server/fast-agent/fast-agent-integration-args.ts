import { FAST_AGENT_NATIVE_TOOL_NAMES } from '@roomote/types';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Top-level keys a tool's JSON schema accepts, or `null` when the schema is
 * not a closed object schema (missing, no `properties`, or open through
 * `additionalProperties` / `patternProperties`) and unknown keys cannot be
 * judged.
 */
function declaredArgumentKeys(toolInputSchema: unknown): string[] | null {
  if (!isPlainRecord(toolInputSchema)) return null;
  if (toolInputSchema.type !== undefined && toolInputSchema.type !== 'object') {
    return null;
  }
  const properties = toolInputSchema.properties;
  if (!isPlainRecord(properties)) return null;
  const additional = toolInputSchema.additionalProperties;
  if (additional === true || isPlainRecord(additional)) return null;
  if (isPlainRecord(toolInputSchema.patternProperties)) return null;
  return Object.keys(properties);
}

/**
 * Models sometimes call a mounted MCP tool with the `call_integration_tool`
 * calling convention, wrapping the real arguments in an `args` field (often
 * as a JSON string). The MCP server silently strips keys it does not
 * declare, so the wrapped values vanish, defaults take over, and the model
 * never learns the call was malformed; once one such call succeeds the
 * pattern repeats for the rest of the session.
 *
 * Instead of guessing what was meant, reject the call with an error that
 * names the unknown keys and the accepted ones so the model corrects itself
 * on the next attempt. Returns `null` when every key is declared or the
 * schema is too open to judge.
 */
export function describeUnknownIntegrationArguments(
  call: { integrationId: string; toolName: string },
  args: Record<string, unknown>,
  toolInputSchema: unknown,
): string | null {
  const declared = declaredArgumentKeys(toolInputSchema);
  if (!declared) return null;
  const declaredSet = new Set(declared);
  const unknown = Object.keys(args).filter((key) => !declaredSet.has(key));
  if (unknown.length === 0) return null;

  const accepted =
    declared.length > 0
      ? `This tool accepts: ${declared.join(', ')}.`
      : 'This tool takes no arguments.';
  const keyList = unknown.map((key) => `"${key}"`).join(', ');
  const wrapperHint = unknown.includes('args')
    ? ` Do not wrap arguments in an "args" field; that convention is only for ${FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool}. Pass each argument at the top level.`
    : '';
  return `Unknown argument ${unknown.length === 1 ? 'key' : 'keys'} ${keyList} for ${call.integrationId} tool ${call.toolName}. ${accepted}${wrapperHint}`;
}
