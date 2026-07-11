import { GET } from '../route';

vi.mock('@/lib/server', () => ({
  Env: {
    R_PUBLIC_URL: 'https://roomote.example.com',
    R_APP_URL: 'https://roomote.example.com',
  },
}));

vi.mock('@/lib/server/bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: vi.fn().mockResolvedValue(undefined),
}));

const BOT_APP_ID = '11111111-2222-3333-4444-555555555555';

function buildRequest(query: string) {
  return new Request(
    `https://roomote.example.com/api/setup/teams-app-package${query}`,
  );
}

describe('GET /api/setup/teams-app-package', () => {
  it('serves a Teams app package for the supplied bot app id', async () => {
    const response = await GET(buildRequest(`?botAppId=${BOT_APP_ID}`));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="roomote-teams-app.zip"',
    );

    const zip = Buffer.from(await response.arrayBuffer());

    // Zip local file header signature.
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);

    const manifestText = zip.toString('utf8');

    expect(manifestText).toContain('manifest.json');
    expect(manifestText).toContain(BOT_APP_ID);
    expect(manifestText).toContain('roomote.example.com');
  });

  it('rejects a missing bot app id', async () => {
    const response = await GET(buildRequest(''));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_bot_app_id',
    });
  });

  it('rejects a bot app id that is not a GUID', async () => {
    const response = await GET(buildRequest('?botAppId=not-a-guid'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_bot_app_id',
    });
  });

  it('rejects a bot name that exceeds the Teams manifest short-name limit', async () => {
    const response = await GET(
      buildRequest(`?botAppId=${BOT_APP_ID}&botName=${'a'.repeat(31)}`),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_bot_name',
    });
  });
});
