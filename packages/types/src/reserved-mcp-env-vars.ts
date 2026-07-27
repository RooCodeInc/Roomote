/**
 * Reserved runtime env var names for operator-configured MCP server config.
 *
 * Custom MCP config passes through two independent substitution engines:
 *
 *   1. Roomote's own `${VAR}` / `$VAR` pass in `resolveBuiltInMcpServers`.
 *   2. OpenCode's `{env:VAR}` pass, which OpenCode applies to the config file
 *      it reads, against the harness process environment.
 *
 * Both must refuse the same names. A name refused by (1) but honored by (2)
 * is not protected at all, because the harness process environment is a
 * superset of the substitution lookup (1) is built from.
 */

/**
 * Names that belong unambiguously to the Roomote runtime. These never
 * substitute into operator-configured MCP config, not even from the
 * operator-provided overlay, so a value injected into an env map by the
 * runtime can never be reclassified as operator-owned.
 */
export function isRoomoteNamespacedEnvVarName(name: string): boolean {
  return (
    name === 'AUTH_TOKEN' ||
    name === 'BASH_ENV' ||
    name.startsWith('ROOMOTE_') ||
    name.startsWith('JOB_AUTH_') ||
    name.startsWith('PREVIEW_AUTH_')
  );
}

/**
 * Roomote runtime / control-plane values that must never be injectable into
 * operator-configured MCP server config. This is deliberately limited to
 * Roomote-internal names: anything the operator defined themselves
 * (deployment env vars) is already present in the sandbox environment, so
 * refusing to substitute it would add friction without protecting anything.
 * Operator-defined names substitute via the overlay in
 * buildMcpSubstitutionLookup; generic reserved names (DATABASE_URL,
 * REDIS_URL) can be shadowed there by an operator's own value,
 * Roomote-namespaced names cannot.
 */
export function isReservedRuntimeMcpEnvVarName(name: string): boolean {
  return (
    isRoomoteNamespacedEnvVarName(name) ||
    name === 'DATABASE_URL' ||
    name === 'REDIS_URL'
  );
}

/**
 * Stand-in written in place of a refused reference.
 *
 * Deliberately contains no `$`, no `{env:` and no braces, so that neither
 * substitution engine can re-parse it into a live reference. Leaving the
 * original `${VAR}` text intact instead is what previously allowed a
 * reference refused by Roomote's pass to be re-read as a live
 * `{env:VAR}` reference by OpenCode's pass.
 */
export const REFUSED_ENV_REFERENCE_PLACEHOLDER =
  'roomote-refused-reserved-env-reference';

/**
 * OpenCode's `{env:VAR}` reference syntax. Unanchored: OpenCode substitutes
 * these anywhere in the config text, so a reference embedded in a URL path or
 * in the middle of a header value resolves just as well as a standalone one.
 */
const OPENCODE_ENV_REFERENCE_PATTERN = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Replace every `{env:VAR}` reference to a reserved runtime name with the
 * refusal placeholder.
 *
 * Apply this to operator-supplied strings on their way into the generated
 * OpenCode config (MCP urls, headers, commands, args, and stdio environment
 * values). Roomote's own `${VAR}` pass cannot cover these: an operator who
 * writes OpenCode syntax directly never matches the `$VAR` / `${VAR}` pattern
 * that pass looks for.
 *
 * Runtime-generated references (the inference gateway's
 * `{env:ROOMOTE_CLOUD_TOKEN}`, generated `ROOMOTE_DIRECT_MCP_*` names) are
 * added to the config after this runs and are deliberately not passed through
 * it.
 */
export function redactReservedOpenCodeEnvReferences(value: string): string {
  return value.replace(OPENCODE_ENV_REFERENCE_PATTERN, (match, name: string) =>
    isReservedRuntimeMcpEnvVarName(name)
      ? REFUSED_ENV_REFERENCE_PLACEHOLDER
      : match,
  );
}

/** The reserved names a value references with OpenCode `{env:VAR}` syntax. */
export function collectReservedOpenCodeEnvReferences(value: string): string[] {
  return Array.from(
    value.matchAll(OPENCODE_ENV_REFERENCE_PATTERN),
    (match) => match[1]!,
  ).filter(isReservedRuntimeMcpEnvVarName);
}

/**
 * Shell-style `$VAR` / `${VAR}` reference syntax, as resolved by the worker's
 * `substituteEnvVars`.
 *
 * Held as a source string rather than a shared `RegExp` so each call site
 * builds its own instance: a global regex carries `lastIndex` state between
 * callers. Both engines' patterns live in this module so a name refused by one
 * cannot silently stay readable by the other.
 */
const ENV_VAR_REFERENCE_PATTERN_SOURCE =
  '\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}|\\$([A-Za-z_][A-Za-z0-9_]*)';

export function createEnvVarReferencePattern(): RegExp {
  return new RegExp(ENV_VAR_REFERENCE_PATTERN_SOURCE, 'g');
}

/**
 * The reserved names a value references in *either* syntax.
 *
 * Used at the control plane to reject a config before it is ever persisted,
 * so the worker-side redaction is a second line of defense rather than the
 * only one.
 */
export function collectReservedEnvReferences(value: string): string[] {
  const shellReferences = Array.from(
    value.matchAll(createEnvVarReferencePattern()),
    (match) => (match[1] ?? match[2])!,
  ).filter(isReservedRuntimeMcpEnvVarName);

  return Array.from(
    new Set([
      ...shellReferences,
      ...collectReservedOpenCodeEnvReferences(value),
    ]),
  );
}
