import { execa } from 'execa';

export async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    const { exitCode } = await execa(
      'bash',
      ['-lc', 'command -v "$1"', '_', command],
      { reject: false, stdin: 'ignore' },
    );

    return exitCode === 0;
  } catch {
    return false;
  }
}
