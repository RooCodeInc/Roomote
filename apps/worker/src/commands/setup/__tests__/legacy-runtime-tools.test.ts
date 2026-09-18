import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareNumericDotVersions,
  isAgentBrowserVersionOlder,
  parseAgentBrowserVersion,
  resolveRepoRelativeInstallerScriptPath,
} from '../legacy-runtime-tools';

describe('parseAgentBrowserVersion', () => {
  it('parses the plain version output', () => {
    expect(parseAgentBrowserVersion('0.27.0')).toBe('0.27.0');
  });

  it('parses labeled agent-browser output', () => {
    expect(parseAgentBrowserVersion('agent-browser 0.27.0')).toBe('0.27.0');
  });

  it('returns undefined when no version is present', () => {
    expect(
      parseAgentBrowserVersion(
        'agent-browser wrapper: failed to resolve real CLI',
      ),
    ).toBeUndefined();
  });
});

describe('compareNumericDotVersions', () => {
  it('sorts older versions before newer ones', () => {
    expect(compareNumericDotVersions('0.26.0', '0.27.0')).toBeLessThan(0);
  });

  it('treats equal versions as equal', () => {
    expect(compareNumericDotVersions('0.27.0', '0.27.0')).toBe(0);
  });

  it('handles longer version strings numerically', () => {
    expect(compareNumericDotVersions('0.27.1', '0.27.0')).toBeGreaterThan(0);
  });
});

describe('isAgentBrowserVersionOlder', () => {
  it('returns true when the installed version is older than the target', () => {
    expect(isAgentBrowserVersionOlder('0.26.0', '0.27.0')).toBe(true);
  });

  it('returns false for equal versions', () => {
    expect(isAgentBrowserVersionOlder('0.27.0', '0.27.0')).toBe(false);
  });

  it('returns false when the installed version is newer', () => {
    expect(isAgentBrowserVersionOlder('0.27.1', '0.27.0')).toBe(false);
  });

  it('returns false when the installed version is unknown', () => {
    expect(isAgentBrowserVersionOlder(undefined, '0.27.0')).toBe(false);
  });
});

describe('install-browser-agent.sh', () => {
  it('replaces a stale saved CLI path after upgrading the npm package', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'agent-browser-upgrade-'),
    );
    const homeDir = path.join(tempDir, 'home');
    const installRoot = path.join(tempDir, 'install');
    const npmPrefix = path.join(tempDir, 'npm');
    const fakeBinDir = path.join(tempDir, 'bin');
    const oldCliPath = path.join(tempDir, 'old-agent-browser');
    const newCliPath = path.join(npmPrefix, 'bin', 'agent-browser');
    const chromePath = path.join(
      homeDir,
      '.agent-browser/browsers/chrome-test/chrome',
    );
    const savedCliPath = path.join(installRoot, '.cli-path');

    fs.mkdirSync(path.dirname(newCliPath), { recursive: true });
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(installRoot, { recursive: true });
    fs.writeFileSync(
      oldCliPath,
      '#!/bin/sh\nprintf "agent-browser 0.33.2\\n"\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(
      newCliPath,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  printf "agent-browser 0.37.0\\n"\nelif [ "$1" = "install" ]; then\n  mkdir -p "${path.dirname(chromePath)}"\n  : > "${chromePath}"\n  chmod +x "${chromePath}"\nfi\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(fakeBinDir, 'npm'),
      `#!/bin/sh\nif [ "$1 $2" = "prefix -g" ]; then\n  printf "${npmPrefix}\\n"\nelif [ "$1 $2" = "install -g" ]; then\n  exit 0\nelse\n  exit 1\nfi\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(savedCliPath, `${oldCliPath}\n`);

    try {
      execFileSync(
        'bash',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.docker/sandbox/install-browser-agent.sh',
              import.meta.url,
            ),
          ),
        ],
        {
          env: {
            ...process.env,
            HOME: homeDir,
            PATH: `${fakeBinDir}:${process.env.PATH}`,
            AGENT_BROWSER_INSTALL_ROOT: installRoot,
            AGENT_BROWSER_EXECUTABLE_PATH: path.join(installRoot, 'chrome'),
            AGENT_BROWSER_SAVED_CLI_PATH: savedCliPath,
            AGENT_BROWSER_INSTALL_MARKER: path.join(installRoot, '.installed'),
            AGENT_BROWSER_SYSTEM_WRAPPER_PATH: path.join(
              tempDir,
              'system-agent-browser',
            ),
            AGENT_BROWSER_USER_WRAPPER_PATH: path.join(
              tempDir,
              'user-agent-browser',
            ),
          },
        },
      );

      expect(fs.readFileSync(savedCliPath, 'utf8').trim()).toBe(newCliPath);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps native FPS support available across image and runtime install pins', () => {
    const installer = fs.readFileSync(
      new URL(
        '../../../../../../.docker/sandbox/install-browser-agent.sh',
        import.meta.url,
      ),
      'utf8',
    );
    const dockerfile = fs.readFileSync(
      new URL('../../../../Dockerfile', import.meta.url),
      'utf8',
    );
    const runtime = fs.readFileSync(
      new URL('../legacy-runtime-tools.ts', import.meta.url),
      'utf8',
    );
    const version = dockerfile.match(/^ARG AGENT_BROWSER_VERSION=(.+)$/m)?.[1];
    expect(version).toBeDefined();
    expect(
      compareNumericDotVersions(version!, '0.37.0'),
    ).toBeGreaterThanOrEqual(0);
    expect(installer).toContain(
      `AGENT_BROWSER_VERSION="\${AGENT_BROWSER_VERSION:-${version}}"`,
    );
    expect(runtime).toContain(`const AGENT_BROWSER_VERSION = '${version}';`);
  });

  it('resolves the shared installer relative to the module instead of process.cwd()', () => {
    const productionModuleUrl = new URL(
      '../legacy-runtime-tools.ts',
      import.meta.url,
    ).href;

    expect(
      path.normalize(
        resolveRepoRelativeInstallerScriptPath(productionModuleUrl),
      ),
    ).toBe(
      path.normalize(
        fileURLToPath(
          new URL(
            '../../../../../../.docker/sandbox/install-browser-agent.sh',
            import.meta.url,
          ),
        ),
      ),
    );
  });

  it('keeps the shared wrapper behavior in the standalone installer', () => {
    const script = fs.readFileSync(
      new URL(
        '../../../../../../.docker/sandbox/install-browser-agent.sh',
        import.meta.url,
      ),
      'utf8',
    );

    expect(script).toContain(
      'DEFAULT_AUTH_BYPASS_HEADER_NAME="x-bypass-roomote-auth"',
    );
    expect(script).toContain(
      'HIDE_PREVIEW_WIDGET_COOKIE="roomote_hide_preview_widget"',
    );
    expect(script).toContain('ROOMOTE_AUTH_BYPASS_VALUE');
    expect(script).toContain('ROOMOTE_*_PREVIEW_URL');
    expect(script).toContain('configure_local_preview_host_resolution');
    expect(script).toContain(
      '--host-resolver-rules=MAP *.${preview_suffix} host.docker.internal',
    );
    expect(script).not.toContain('ROOMOTE_EDITOR_PREVIEW_URL');
    expect(script).toContain('open|goto|navigate');
    expect(script).toContain('cookies set "$header_name" "$bypass_value"');
    expect(script).toContain('cookies set "$HIDE_PREVIEW_WIDGET_COOKIE" "1"');
    expect(script).toContain('https://*) cookie_security_args+=(--secure)');
    expect(script).toContain('"${cookie_security_args[@]}" --sameSite Lax');
    expect(script).not.toContain('--url "$url" --secure');
    expect(script).toContain(
      'export AGENT_BROWSER_EXECUTABLE_PATH="${AGENT_BROWSER_EXECUTABLE_PATH:-/opt/agent-browser/chrome}"',
    );
    expect(script).toContain('local saved_path="/opt/agent-browser/.cli-path"');
    expect(script).toContain('ensure_home_dir_traversable_for_gpu_process');
    expect(script).toContain('chmod o+x "$home_dir"');
  });

  it('writes sudo-managed wrapper paths without a guaranteed permission error first', () => {
    const script = fs.readFileSync(
      new URL(
        '../../../../../../.docker/sandbox/install-browser-agent.sh',
        import.meta.url,
      ),
      'utf8',
    );

    expect(script.indexOf('if [ "$allow_sudo" = "true" ]; then')).toBeLessThan(
      script.indexOf('if cat > "$file_path"; then'),
    );
  });
});
