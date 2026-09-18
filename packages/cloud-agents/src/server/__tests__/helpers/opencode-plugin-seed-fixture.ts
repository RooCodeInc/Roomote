import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { OPENCODE_PLUGIN_PACKAGE_NAME } from '../../opencode-plugin-seed';

/**
 * Writes the minimum tree OpenCode's `Npm.install` treats as already
 * installed: package.json declaring the plugin, a lockfile whose root lists
 * it, and the installed package's own package.json.
 */
export function writeOpenCodePluginSeedFixture(
  dir: string,
  version: string,
  options: { installedVersion?: string; lockRootDependencies?: string[] } = {},
): void {
  const pluginDir = path.join(
    dir,
    'node_modules',
    ...OPENCODE_PLUGIN_PACKAGE_NAME.split('/'),
  );
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'opencode',
      private: true,
      dependencies: { [OPENCODE_PLUGIN_PACKAGE_NAME]: version },
    }),
  );
  const lockRoot = options.lockRootDependencies ?? [
    OPENCODE_PLUGIN_PACKAGE_NAME,
  ];
  writeFileSync(
    path.join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'opencode',
      lockfileVersion: 3,
      packages: {
        '': {
          dependencies: Object.fromEntries(
            lockRoot.map((name) => [name, version]),
          ),
        },
        [`node_modules/${OPENCODE_PLUGIN_PACKAGE_NAME}`]: { version },
      },
    }),
  );
  writeFileSync(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({
      name: OPENCODE_PLUGIN_PACKAGE_NAME,
      version: options.installedVersion ?? version,
    }),
  );
  writeFileSync(path.join(pluginDir, 'index.js'), 'export {};\n');
}
