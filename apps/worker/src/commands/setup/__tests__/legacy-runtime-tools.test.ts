import * as fs from 'node:fs';
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
