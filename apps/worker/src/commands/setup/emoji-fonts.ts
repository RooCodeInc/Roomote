import { execa } from 'execa';

import type { StartupLogger } from '../../logging';
import { withAptLock } from './package-manager';

const REQUIRED_FONT_PACKAGES = [
  'fontconfig',
  'fonts-noto-core',
  'fonts-noto-color-emoji',
] as const;

async function refreshFontCache(logger: StartupLogger): Promise<void> {
  try {
    await execa('fc-cache', ['-f'], { reject: false, stdin: 'ignore' });
  } catch {
    logger.debug.log('fc-cache not available');
  }
}

async function ensureBaseFontPackages(logger: StartupLogger): Promise<void> {
  try {
    logger.debug.log('Installing browser font packages');

    const { exitCode } = await withAptLock(() =>
      execa(
        'sudo',
        ['-n', 'apt-get', 'install', '-y', ...REQUIRED_FONT_PACKAGES],
        {
          reject: false,
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        },
      ),
    );

    if (exitCode === 0) {
      await refreshFontCache(logger);
      logger.debug.log('Browser font packages installed');
    } else {
      logger.debug.log('Browser font package install failed');
    }
  } catch {
    logger.debug.log(
      'APT install unavailable, skipping browser font package install',
    );
  }
}

async function hasRequiredBrowserFontPackages(): Promise<boolean> {
  try {
    const { exitCode, stdout } = await execa(
      'dpkg-query',
      ['-W', '-f=${Package} ${Status}\\n', ...REQUIRED_FONT_PACKAGES],
      {
        reject: false,
        stdin: 'ignore',
        stderr: 'ignore',
      },
    );

    if (exitCode !== 0) {
      return false;
    }

    const installedPackages = new Set(
      stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );

    return REQUIRED_FONT_PACKAGES.every((pkg) =>
      installedPackages.has(`${pkg} install ok installed`),
    );
  } catch {
    return false;
  }
}

/**
 * Ensures the browser font packages needed for emoji rendering exist.
 * Idempotent — skips when the required distro packages are already present.
 * Non-fatal — font install failures never block setup.
 */
export async function installEmojiFont(logger: StartupLogger): Promise<void> {
  if (await hasRequiredBrowserFontPackages()) {
    return;
  }

  await ensureBaseFontPackages(logger);
}
