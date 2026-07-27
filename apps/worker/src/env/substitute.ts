import { createEnvVarReferencePattern } from '@roomote/types';

/**
 * Resolve $VAR and ${VAR} references in env var values against a lookup map.
 *
 * Supports both shell-style syntaxes:
 *   - ${VAR_NAME}  braced, preferred -- unambiguous
 *   - $VAR_NAME    bare, greedy identifier match per shell convention
 *
 * SECURITY:
 *   - Does NOT use shell evaluation, eval(), or child_process.
 *   - Does NOT expand $(command) or backtick syntax.
 *   - Single-pass replacement -- no recursive expansion.
 *   - Lookup is explicitly provided, never reads process.env.
 *   - Unresolved references are left intact for visibility. Callers that need
 *     a reference *neutralized* rather than merely unresolved must use
 *     `redactEnvVarReferences` first; see its doc comment.
 */
const ENV_VAR_REFERENCE_PATTERN = createEnvVarReferencePattern();

export function substituteEnvVars(
  vars: Record<string, string>,
  lookup: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(vars)) {
    result[key] = value.replace(
      ENV_VAR_REFERENCE_PATTERN,
      (match, braced: string | undefined, bare: string | undefined) => {
        const varName = braced ?? bare!;
        return varName in lookup ? lookup[varName]! : match;
      },
    );
  }

  return result;
}

/** List the $VAR / ${VAR} names a value references, in order of appearance. */
export function collectEnvVarReferences(value: string): string[] {
  return Array.from(
    value.matchAll(ENV_VAR_REFERENCE_PATTERN),
    (match) => (match[1] ?? match[2])!,
  );
}

/**
 * Replace $VAR / ${VAR} references whose name matches `shouldRedact` with
 * `placeholder`, leaving every other reference untouched for a later
 * substitution pass.
 *
 * Use this when a reference must be *neutralized* rather than merely left
 * unsubstituted. `substituteEnvVars` leaves unresolved references intact,
 * which is right for a misspelling (it keeps the mistake visible) but wrong
 * for a deliberately refused name: intact `${VAR}` text stays readable by
 * downstream substitution engines that resolve against a broader environment.
 */
export function redactEnvVarReferences(
  values: Record<string, string>,
  shouldRedact: (name: string) => boolean,
  placeholder: string,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(values)) {
    result[key] = value.replace(
      ENV_VAR_REFERENCE_PATTERN,
      (match, braced: string | undefined, bare: string | undefined) =>
        shouldRedact(braced ?? bare!) ? placeholder : match,
    );
  }

  return result;
}
