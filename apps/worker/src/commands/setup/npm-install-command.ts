import { execa } from 'execa';

type InstallCommand = {
  argsPrefix: string[];
  command: string;
};

const DEFAULT_NODEJS_MISE_SPEC = 'nodejs@22';

async function isHealthyInstallCommand(
  command: InstallCommand,
): Promise<boolean> {
  try {
    const result = await execa(
      command.command,
      [...command.argsPrefix, '--version'],
      {
        reject: false,
        stdin: 'ignore',
      },
    );

    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export async function resolveNpmInstallCommand(): Promise<InstallCommand> {
  try {
    const resolved = await execa('bash', ['-lc', 'mise which npm'], {
      reject: false,
      stdin: 'ignore',
    });

    if (resolved.exitCode === 0 && resolved.stdout.trim()) {
      return {
        command: resolved.stdout.trim(),
        argsPrefix: [],
      };
    }

    const repaired = await execa(
      'bash',
      [
        '-lc',
        `mise use -g ${DEFAULT_NODEJS_MISE_SPEC} >/dev/null 2>&1 && mise which npm`,
      ],
      {
        reject: false,
        stdin: 'ignore',
      },
    );

    if (repaired.exitCode === 0 && repaired.stdout.trim()) {
      return {
        command: repaired.stdout.trim(),
        argsPrefix: [],
      };
    }
  } catch {
    // Fall through to the PATH-based npm shim.
  }

  const pathCommand = {
    command: 'npm',
    argsPrefix: [],
  };

  if (await isHealthyInstallCommand(pathCommand)) {
    return pathCommand;
  }

  throw new Error(
    'Unable to resolve a healthy npm install command from mise or PATH',
  );
}
