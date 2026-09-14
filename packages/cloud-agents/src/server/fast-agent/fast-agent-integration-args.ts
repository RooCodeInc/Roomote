function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function schemaDeclaresArgsProperty(inputSchema: unknown): boolean {
  if (!isPlainRecord(inputSchema)) return false;
  const properties = inputSchema.properties;
  return isPlainRecord(properties) && 'args' in properties;
}

/**
 * Models sometimes wrap a tool's real arguments in an `args` field — the
 * `call_integration_tool` calling convention — while invoking the MCP tool
 * directly, and often as a JSON string. The MCP server drops the unknown key,
 * so explicit values such as an `oldest` bound vanish and defaults take over.
 *
 * Unwrap that field when the target tool does not itself declare an `args`
 * property. Top-level keys win; the wrapper only fills gaps.
 */
export function unwrapStringifiedIntegrationArgs(
  args: Record<string, unknown>,
  toolInputSchema: unknown,
): Record<string, unknown> {
  if (!('args' in args) || schemaDeclaresArgsProperty(toolInputSchema)) {
    return args;
  }

  const { args: wrapped, ...rest } = args;
  let nested: unknown = wrapped;

  if (typeof wrapped === 'string') {
    const trimmed = wrapped.trim();
    if (!trimmed) return rest;
    try {
      nested = JSON.parse(trimmed);
    } catch {
      return args;
    }
  }

  if (!isPlainRecord(nested)) {
    return args;
  }

  return { ...nested, ...rest };
}
