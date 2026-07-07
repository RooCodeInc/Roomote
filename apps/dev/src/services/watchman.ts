import path from 'path';

import { execa } from 'execa';
import ora from 'ora';

export class WatchmanService {
  public static async checkInstalled(): Promise<void> {
    const watchmanCheck = ora('Checking file watcher installation').start();

    if (await this.hasSupportedWatcher()) {
      watchmanCheck.succeed();
      return;
    }

    watchmanCheck.warn(
      'No supported file watcher found, attempting installation',
    );

    const installWatchman = ora('Installing Watchman').start();
    const rootDir = path.resolve(process.cwd(), '../..');

    try {
      await execa('bash', ['scripts/install-watchman.sh'], {
        cwd: rootDir,
        stdio: 'inherit',
      });

      if (!(await this.hasSupportedWatcher())) {
        throw new Error(
          'Installer completed but no supported file watcher is available.',
        );
      }

      installWatchman.succeed();
    } catch (error) {
      installWatchman.fail();
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      throw new Error(
        'Failed to install Watchman automatically.\n' +
          'Please run the repo installer manually:\n' +
          '  ./scripts/install-watchman.sh\n' +
          '\n' +
          errorMessage,
      );
    }
  }

  private static async hasSupportedWatcher(): Promise<boolean> {
    return (
      (await this.commandSucceeds('watchman', ['--version'])) ||
      (await this.commandExists('inotifywait'))
    );
  }

  private static async commandSucceeds(
    command: string,
    args: string[],
  ): Promise<boolean> {
    try {
      const result = await execa(command, args, { reject: false });
      return result.exitCode === 0;
    } catch (_error) {
      return false;
    }
  }

  private static async commandExists(command: string): Promise<boolean> {
    try {
      const result = await execa('bash', ['-lc', `command -v ${command}`], {
        reject: false,
      });
      return result.exitCode === 0;
    } catch (_error) {
      return false;
    }
  }
}
