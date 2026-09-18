import {
  and,
  db,
  deploymentSettings,
  environmentVariables,
  eq,
  inArray,
  isNull,
  resolveModelProviderEnvValue,
  userFactory,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import {
  deleteJudgmentTypeSafeKeyCommand,
  getJudgmentModelSettingsCommand,
  saveJudgmentTypeSafeKeyCommand,
  setJudgmentModelSelectionCommand,
} from './judgment-model';

const MANAGED_ENV_VAR_NAMES = [
  'R_TYPESAFE_API_KEY',
  'OPENROUTER_API_KEY',
  'AI_GATEWAY_API_KEY',
];

let adminAuth: UserAuthSuccess;
let memberAuth: UserAuthSuccess;

async function cleanup() {
  await db
    .delete(environmentVariables)
    .where(inArray(environmentVariables.name, MANAGED_ENV_VAR_NAMES));
  await db
    .delete(deploymentSettings)
    .where(eq(deploymentSettings.id, 'default'));
}

async function storedTypeSafeKeyRows() {
  return db
    .select({ name: environmentVariables.name })
    .from(environmentVariables)
    .where(
      and(
        isNull(environmentVariables.userId),
        eq(environmentVariables.name, 'R_TYPESAFE_API_KEY'),
      ),
    );
}

function stubTypeSafeResponse(status: number) {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ answers: { ok: { type: 'noul', noul: 0.9 } } }),
        { status, headers: { 'content-type': 'application/json' } },
      ),
    );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('judgment model settings commands', () => {
  beforeEach(async () => {
    await cleanup();
    vi.stubEnv('R_TYPESAFE_API_KEY', '');
    vi.stubEnv('R_JUDGMENT_MODEL', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const admin = await userFactory.create();
    adminAuth = {
      success: true,
      userType: 'user',
      userId: admin.id,
      isAdmin: true,
    } as UserAuthSuccess;
    memberAuth = { ...adminAuth, isAdmin: false } as UserAuthSuccess;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await cleanup();
  });

  it('reports nothing connected and Off by default', async () => {
    await expect(getJudgmentModelSettingsCommand(adminAuth)).resolves.toEqual({
      typeSafe: { connected: false, source: null },
      openRouterConnected: false,
      vercelGatewayConnected: false,
      storedSelection: null,
      envSelection: null,
      effectiveSelection: 'off',
      effectiveSelectionUsable: true,
    });
  });

  it('rejects non-admins on every procedure', async () => {
    await expect(getJudgmentModelSettingsCommand(memberAuth)).rejects.toThrow(
      'Unauthorized',
    );
    await expect(
      saveJudgmentTypeSafeKeyCommand(memberAuth, { apiKey: 'ts-key' }),
    ).rejects.toThrow('Unauthorized');
    await expect(deleteJudgmentTypeSafeKeyCommand(memberAuth)).rejects.toThrow(
      'Unauthorized',
    );
    await expect(
      setJudgmentModelSelectionCommand(memberAuth, { selection: 'off' }),
    ).rejects.toThrow('Unauthorized');
  });

  it('checks a new TypeSafe key, stores it, and implies Jev via TypeSafe', async () => {
    const fetchMock = stubTypeSafeResponse(200);

    const result = await saveJudgmentTypeSafeKeyCommand(adminAuth, {
      apiKey: '  ts-secret  ',
    });

    expect(result.keyCheck).toBe('verified');
    expect(result.settings).toMatchObject({
      typeSafe: { connected: true, source: 'settings' },
      storedSelection: null,
      effectiveSelection: 'typesafe',
      effectiveSelectionUsable: true,
    });
    expect(JSON.stringify(result)).not.toContain('ts-secret');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer ts-secret',
    );
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'jev-latest',
      state: 'ping',
      questions: { ok: { type: 'noul', instructions: 'Is this a ping?' } },
    });

    const [row] = await db
      .select({ value: environmentVariables.value })
      .from(environmentVariables)
      .where(eq(environmentVariables.name, 'R_TYPESAFE_API_KEY'));
    // Stored encrypted, and resolvable by the judgment runtime.
    expect(row?.value).not.toContain('ts-secret');
    await expect(
      resolveModelProviderEnvValue(['R_TYPESAFE_API_KEY'], { runtimeEnv: {} }),
    ).resolves.toBe('ts-secret');
  });

  it.each([401, 403])(
    'does not store a key TypeSafe rejects with %i',
    async (status) => {
      stubTypeSafeResponse(status);

      await expect(
        saveJudgmentTypeSafeKeyCommand(adminAuth, { apiKey: 'ts-bad' }),
      ).rejects.toThrow('TypeSafe rejected this API key.');
      await expect(storedTypeSafeKeyRows()).resolves.toHaveLength(0);
    },
  );

  it('stores the key unverified when TypeSafe cannot confirm it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

    await expect(
      saveJudgmentTypeSafeKeyCommand(adminAuth, { apiKey: 'ts-offline' }),
    ).resolves.toMatchObject({ keyCheck: 'unverified' });

    stubTypeSafeResponse(500);
    await expect(
      saveJudgmentTypeSafeKeyCommand(adminAuth, { apiKey: 'ts-flaky' }),
    ).resolves.toMatchObject({ keyCheck: 'unverified' });
    await expect(storedTypeSafeKeyRows()).resolves.toHaveLength(1);
  });

  it('treats an environment key as locked', async () => {
    const fetchMock = stubTypeSafeResponse(200);
    vi.stubEnv('R_TYPESAFE_API_KEY', 'ts-env-key');

    await expect(
      getJudgmentModelSettingsCommand(adminAuth),
    ).resolves.toMatchObject({
      typeSafe: { connected: true, source: 'environment' },
      effectiveSelection: 'typesafe',
    });
    await expect(
      saveJudgmentTypeSafeKeyCommand(adminAuth, { apiKey: 'ts-other' }),
    ).rejects.toThrow('managed by R_TYPESAFE_API_KEY');
    await expect(deleteJudgmentTypeSafeKeyCommand(adminAuth)).rejects.toThrow(
      'managed by R_TYPESAFE_API_KEY',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deletes a saved key and keeps an explicit TypeSafe selection as unusable', async () => {
    stubTypeSafeResponse(200);
    await saveJudgmentTypeSafeKeyCommand(adminAuth, { apiKey: 'ts-secret' });
    await setJudgmentModelSelectionCommand(adminAuth, {
      selection: 'typesafe',
    });

    await expect(
      deleteJudgmentTypeSafeKeyCommand(adminAuth),
    ).resolves.toMatchObject({
      typeSafe: { connected: false, source: null },
      storedSelection: 'typesafe',
      effectiveSelection: 'typesafe',
      effectiveSelectionUsable: false,
    });
    await expect(storedTypeSafeKeyRows()).resolves.toHaveLength(0);
    await expect(deleteJudgmentTypeSafeKeyCommand(adminAuth)).rejects.toThrow(
      'TypeSafe does not have a saved API key.',
    );
  });

  it('only allows selections whose provider is connected', async () => {
    await expect(
      setJudgmentModelSelectionCommand(adminAuth, { selection: 'typesafe' }),
    ).rejects.toThrow('Connect TypeSafe before choosing Jev via TypeSafe.');
    await expect(
      setJudgmentModelSelectionCommand(adminAuth, { selection: 'vercel' }),
    ).rejects.toThrow(
      'Connect Vercel AI Gateway before choosing Jev via Vercel AI Gateway.',
    );
    await expect(
      setJudgmentModelSelectionCommand(adminAuth, { selection: 'openrouter' }),
    ).rejects.toThrow('Connect OpenRouter before choosing Jev via OpenRouter.');

    // Off is always allowed, even before a deployment settings row exists.
    await expect(
      setJudgmentModelSelectionCommand(adminAuth, { selection: 'off' }),
    ).resolves.toMatchObject({
      storedSelection: 'off',
      effectiveSelection: 'off',
    });

    vi.stubEnv('AI_GATEWAY_API_KEY', 'gateway-key');
    const settings = await setJudgmentModelSelectionCommand(adminAuth, {
      selection: 'vercel',
    });
    expect(settings).toMatchObject({
      vercelGatewayConnected: true,
      storedSelection: 'vercel',
      effectiveSelection: 'vercel',
      effectiveSelectionUsable: true,
    });
    expect(JSON.stringify(settings)).not.toContain('gateway-key');

    vi.stubEnv('OPENROUTER_API_KEY', 'openrouter-key');
    const openRouterSettings = await setJudgmentModelSelectionCommand(
      adminAuth,
      { selection: 'openrouter' },
    );
    expect(openRouterSettings).toMatchObject({
      openRouterConnected: true,
      storedSelection: 'openrouter',
      effectiveSelection: 'openrouter',
      effectiveSelectionUsable: true,
    });
    expect(JSON.stringify(openRouterSettings)).not.toContain('openrouter-key');
  });

  it('keeps other deployment metadata when saving a selection', async () => {
    await db.insert(deploymentSettings).values({
      id: 'default',
      metadata: { unrelated: true },
    });

    await setJudgmentModelSelectionCommand(adminAuth, { selection: 'off' });

    const deployment = await db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
      columns: { metadata: true },
    });
    expect(deployment?.metadata).toEqual({
      unrelated: true,
      judgment_model: 'off',
    });
  });

  it('locks the selection when R_JUDGMENT_MODEL is set', async () => {
    vi.stubEnv('R_JUDGMENT_MODEL', 'vercel');

    await expect(
      getJudgmentModelSettingsCommand(adminAuth),
    ).resolves.toMatchObject({
      envSelection: 'vercel',
      effectiveSelection: 'vercel',
      effectiveSelectionUsable: false,
    });
    await expect(
      setJudgmentModelSelectionCommand(adminAuth, { selection: 'off' }),
    ).rejects.toThrow('managed by R_JUDGMENT_MODEL');
  });
});
