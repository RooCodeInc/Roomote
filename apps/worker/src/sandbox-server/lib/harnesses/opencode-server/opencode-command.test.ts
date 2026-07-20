import { describe, expect, it } from 'vitest';

import { resolveOpenCodeCommand, shellEscape } from './opencode-command';

describe('resolveOpenCodeCommand', () => {
  it('defaults to bare opencode when OPENCODE_COMMAND is unset', () => {
    expect(resolveOpenCodeCommand(['serve', '--port', '1'], {})).toEqual({
      command: 'opencode',
      args: ['serve', '--port', '1'],
    });
  });

  it('wraps OPENCODE_COMMAND through bash -lc for serve and version probes', () => {
    expect(
      resolveOpenCodeCommand(['--version'], {
        OPENCODE_COMMAND: '/opt/bin/opencode-wrapper',
      }),
    ).toEqual({
      command: 'bash',
      args: ['-lc', `/opt/bin/opencode-wrapper ${shellEscape('--version')}`],
    });

    expect(
      resolveOpenCodeCommand(['serve', '--port', '4096'], {
        OPENCODE_COMMAND: '/opt/bin/opencode-wrapper',
      }),
    ).toEqual({
      command: 'bash',
      args: [
        '-lc',
        `/opt/bin/opencode-wrapper ${shellEscape('serve')} ${shellEscape('--port')} ${shellEscape('4096')}`,
      ],
    });
  });
});
