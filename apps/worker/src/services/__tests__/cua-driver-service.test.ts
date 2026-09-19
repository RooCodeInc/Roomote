import { access, mkdir, writeFile } from 'node:fs/promises';

import {
  CUA_DRIVER_MANIFEST_PATH,
  buildCuaDriverCapabilityManifest,
  configureCuaDriver,
} from '../cua-driver-service';

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

describe('buildCuaDriverCapabilityManifest', () => {
  it('allows only typed browser tools and keeps desktop access disabled', () => {
    const manifest = buildCuaDriverCapabilityManifest({
      provider: 'cua-driver',
      browser_origins: ['http://127.0.0.1:4173'],
    });

    expect(manifest).toContain('browser_navigate');
    expect(manifest).toContain('http://127.0.0.1:4173');
    expect(manifest).toContain('/opt/agent-browser/chrome');
    expect(manifest).toContain('kind: existing_profile');
    expect(manifest).not.toContain('kind: isolated');
    expect(manifest).toContain('display: false');
    expect(manifest).not.toContain('get_desktop_state');
    expect(manifest).not.toContain('type_text');
  });
});

describe('configureCuaDriver', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(access).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
  });

  it('writes a private manifest and exports the guarded MCP runtime config', async () => {
    const env: Record<string, string | undefined> = {
      DISPLAY: ':99',
      ROOMOTE_DESKTOP_STREAM_PORT: '6080',
    };

    await expect(
      configureCuaDriver({
        config: {
          provider: 'cua-driver',
          browser_origins: ['http://127.0.0.1:4173'],
        },
        env,
      }),
    ).resolves.toBe(true);

    expect(writeFile).toHaveBeenCalledWith(
      CUA_DRIVER_MANIFEST_PATH,
      expect.stringContaining('http://127.0.0.1:4173'),
      { mode: 0o600 },
    );
    expect(env).toMatchObject({
      ROOMOTE_CUA_DRIVER_BINARY: '/usr/local/bin/cua-driver',
      ROOMOTE_CUA_DRIVER_MANIFEST_PATH: CUA_DRIVER_MANIFEST_PATH,
      ROOMOTE_CUA_DRIVER_HUMAN_CONTROL_URL: 'http://127.0.0.1:6080/metrics',
    });
  });

  it('does not enable the MCP without a running Shared Desktop', async () => {
    const env: Record<string, string | undefined> = {};

    await expect(
      configureCuaDriver({
        config: {
          provider: 'cua-driver',
          browser_origins: ['http://127.0.0.1:4173'],
        },
        env,
      }),
    ).resolves.toBe(false);

    expect(writeFile).not.toHaveBeenCalled();
    expect(env).not.toHaveProperty('ROOMOTE_CUA_DRIVER_MANIFEST_PATH');
  });
});
