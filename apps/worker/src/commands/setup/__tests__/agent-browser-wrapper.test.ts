import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const installerPath = fileURLToPath(
  new URL(
    '../../../../../../.docker/sandbox/install-browser-agent.sh',
    import.meta.url,
  ),
);

function readWrapper(): string {
  const installer = fs.readFileSync(installerPath, 'utf8');
  const match = installer.match(/cat <<'EOF_WRAPPER'\n([\s\S]*?)\nEOF_WRAPPER/);
  if (!match?.[1]) {
    throw new Error('Could not extract agent-browser wrapper');
  }
  return match[1];
}

describe('agent-browser wrapper', () => {
  it.each([
    ['--help'],
    ['--version'],
    ['record', 'start', '/tmp/help-start.webm', '--help'],
    ['record', 'restart', '/tmp/help-restart.webm', '--help'],
  ])(
    'forwards informational invocation without preview setup: %s',
    (...args) => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'agent-browser-wrapper-'),
      );
      const cliPath = path.join(tempDir, 'agent-browser-real');
      const wrapperPath = path.join(tempDir, 'agent-browser');
      const callsPath = path.join(tempDir, 'calls');
      const savedCliPath = path.join(tempDir, '.cli-path');

      fs.writeFileSync(
        cliPath,
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$AGENT_BROWSER_TEST_CALLS"\n',
        { mode: 0o755 },
      );
      fs.writeFileSync(savedCliPath, cliPath);
      fs.writeFileSync(
        wrapperPath,
        readWrapper()
          .replace('/opt/agent-browser/.cli-path', savedCliPath)
          .replace(
            '/tmp/agent-browser-cookie-seed',
            path.join(tempDir, 'cache'),
          ),
        { mode: 0o755 },
      );

      try {
        execFileSync(wrapperPath, args, {
          env: {
            ...process.env,
            AGENT_BROWSER_TEST_CALLS: callsPath,
            ROOMOTE_WEB_PREVIEW_URL: 'https://preview.example.com',
          },
        });

        expect(fs.readFileSync(callsPath, 'utf8').trim().split('\n')).toEqual([
          args.join(' '),
        ]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});
