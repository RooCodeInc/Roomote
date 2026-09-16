import { access, writeFile } from 'node:fs/promises';

import {
  buildSharedDesktopStartupScript,
  startSharedDesktop,
} from '../shared-desktop-service';

const execute = vi.fn();

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('../../command-executor', () => ({
  CommandExecutor: class {
    execute = execute;
  },
}));

describe('buildSharedDesktopStartupScript', () => {
  it('drops root privileges before starting PulseAudio and forwards the stream env', () => {
    const script = buildSharedDesktopStartupScript();
    const reexec = script.indexOf('exec sudo -n -u roomote -H');
    const pulse = script.indexOf('pulseaudio --start');

    expect(reexec).toBeGreaterThan(-1);
    expect(pulse).toBeGreaterThan(reexec);
    expect(script).toContain('mkdir -p /tmp/.X11-unix');
    expect(script).toMatch(
      /--preserve-env=DISPLAY,PULSE_SINK,[A-Z_,]*ROOMOTE_DESKTOP_STREAM_ALLOWED_CONTROL_ORIGIN/,
    );
    // Unset optional settings must stay unset rather than become empty strings.
    expect(script).not.toContain(':-}"');
    expect(
      script.trimEnd().endsWith('exec /usr/local/bin/roomote-desktop-stream'),
    ).toBe(true);
  });
});

describe('startSharedDesktop', () => {
  beforeEach(() => {
    execute.mockReset();
    vi.mocked(access).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes the startup script to disk and launches it as one detached command', async () => {
    const env: Record<string, string | undefined> = {};

    await expect(
      startSharedDesktop({
        cwd: '/sandbox/repos',
        env,
        allowedControlOrigin: 'https://app.roomote.dev',
      }),
    ).resolves.toBe(true);

    const [scriptPath, contents] = vi.mocked(writeFile).mock.calls[0]!;
    expect(String(scriptPath)).toMatch(/roomote-shared-desktop\.sh$/);
    expect(contents).toBe(buildSharedDesktopStartupScript());

    expect(execute).toHaveBeenCalledTimes(1);
    const command = execute.mock.calls[0]![0];
    expect(command.run).toBe(`bash ${String(scriptPath)}`);
    expect(command.run).not.toContain('\n');
    expect(command.detached).toBe(true);

    expect(env).toMatchObject({
      DISPLAY: ':99',
      PULSE_SINK: 'roomote_stream',
      ROOMOTE_DESKTOP_STREAM_AUDIO_MODE: 'pulse',
      ROOMOTE_DESKTOP_STREAM_PORT: '6080',
      ROOMOTE_DESKTOP_STREAM_ALLOWED_CONTROL_ORIGIN: 'https://app.roomote.dev',
    });
  });

  it('skips quietly when the worker image has no streaming binary', async () => {
    vi.mocked(access).mockRejectedValue(new Error('ENOENT'));

    await expect(
      startSharedDesktop({ cwd: '/sandbox/repos', env: {} }),
    ).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});
