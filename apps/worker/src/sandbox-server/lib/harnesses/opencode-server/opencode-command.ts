/**
 * Shared launch resolution for the OpenCode CLI.
 *
 * `OPENCODE_COMMAND`, when set, is a shell-fragment that prefixes the CLI
 * (for example a wrapped binary path). Serve and diagnostic probes must use
 * the same resolution so the seeded plugin version matches the binary that
 * actually runs.
 */

export function shellEscape(value: string): string {
  const escapedSingleQuote = `'"'"'`;
  return `'${value.replace(/'/g, escapedSingleQuote)}'`;
}

export function resolveOpenCodeCommand(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): {
  command: string;
  args: string[];
} {
  const configured = env.OPENCODE_COMMAND?.trim();

  if (!configured) {
    return { command: 'opencode', args };
  }

  return {
    command: 'bash',
    args: ['-lc', `${configured} ${args.map(shellEscape).join(' ')}`],
  };
}
