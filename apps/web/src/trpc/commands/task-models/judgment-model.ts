import {
  and,
  db,
  environmentVariables,
  eq,
  getDeploymentJudgmentModelSelection,
  isNull,
  resolveModelProviderEnvValue,
  setDeploymentJudgmentModelSelection,
} from '@roomote/db/server';
import {
  isConfiguredEnvValue,
  isJudgmentModelSelection,
  JUDGMENT_MODEL_ENV_VAR_NAME,
  JUDGMENT_MODEL_SELECTION_LABELS,
  JUDGMENT_UPSTREAM_URL_ENV_VAR_NAME,
  resolveEffectiveJudgmentModelSelection,
  TYPESAFE_API_KEY_ENV_VAR_NAME,
  type JudgmentModelSelection,
} from '@roomote/types';

import { upsertDeploymentEnvironmentVariables } from '../environment-variables';
import type { UserAuthSuccess } from '@/types';

/**
 * Settings > Models controls for the optional judgment model: TypeSafe's Jev
 * through one of its routes, or the judgment model Roomote runs itself.
 *
 * The TypeSafe key is stored as a deployment environment variable like chat
 * provider keys, but deliberately outside the chat provider catalog: it must
 * never count as an inference provider, reach a sandbox, or join a model
 * picker. The browser only ever receives connection status, never a key.
 *
 * Runtime processes resolve the judgment backend through a 30-second
 * per-process cache (`packages/cloud-agents/src/server/typesafe-judgment.ts`),
 * so changes made here take effect within that window. There is no
 * cross-process reset.
 */

const VERCEL_AI_GATEWAY_ENV_VAR_NAMES = ['AI_GATEWAY_API_KEY'] as const;
const OPENROUTER_ENV_VAR_NAMES = ['OPENROUTER_API_KEY'] as const;
const TYPESAFE_KEY_CHECK_URL = 'https://api.typesafe.ai/v1/systemone';
const TYPESAFE_KEY_CHECK_TIMEOUT_MS = 5_000;

type TypeSafeKeySource = 'environment' | 'settings';

type JudgmentModelSettings = {
  typeSafe: {
    connected: boolean;
    source: TypeSafeKeySource | null;
  };
  openRouterConnected: boolean;
  vercelGatewayConnected: boolean;
  /** A Roomote-run judgment upstream is configured in the environment. */
  roomoteConnected: boolean;
  storedSelection: JudgmentModelSelection | null;
  /** Set when `R_JUDGMENT_MODEL` manages the selection; the UI is locked. */
  envSelection: JudgmentModelSelection | null;
  effectiveSelection: JudgmentModelSelection;
  /**
   * Whether the effective selection has the key it needs. `off` is always
   * usable; an unusable selection behaves like `off` at runtime.
   */
  effectiveSelectionUsable: boolean;
};

type TypeSafeKeyCheck = 'verified' | 'unverified';

function assertAdmin(auth: UserAuthSuccess): asserts auth is UserAuthSuccess {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
}

function resolveEnvJudgmentModelSelection(): JudgmentModelSelection | null {
  const value = process.env[JUDGMENT_MODEL_ENV_VAR_NAME]?.trim();

  return isJudgmentModelSelection(value) ? value : null;
}

async function resolveTypeSafeKeySource(): Promise<TypeSafeKeySource | null> {
  // The runtime env wins over the stored key (see
  // `resolveModelProviderEnvValue`), so an env key cannot be replaced here.
  if (isConfiguredEnvValue(process.env[TYPESAFE_API_KEY_ENV_VAR_NAME])) {
    return 'environment';
  }

  const storedKey = await resolveModelProviderEnvValue(
    [TYPESAFE_API_KEY_ENV_VAR_NAME],
    { runtimeEnv: {} },
  );

  return storedKey ? 'settings' : null;
}

async function isVercelGatewayConnected(): Promise<boolean> {
  return Boolean(
    await resolveModelProviderEnvValue(VERCEL_AI_GATEWAY_ENV_VAR_NAMES),
  );
}

async function isOpenRouterConnected(): Promise<boolean> {
  return Boolean(await resolveModelProviderEnvValue(OPENROUTER_ENV_VAR_NAMES));
}

/**
 * Environment only: hosting injects the upstream for managed deployments and
 * a self-hosted operator sets it beside the other deployment variables. There
 * is deliberately no Settings field, so an admin cannot point routing text at
 * an arbitrary server from the browser.
 */
function isRoomoteUpstreamConfigured(): boolean {
  return isConfiguredEnvValue(process.env[JUDGMENT_UPSTREAM_URL_ENV_VAR_NAME]);
}

export async function getJudgmentModelSettingsCommand(
  auth: UserAuthSuccess,
): Promise<JudgmentModelSettings> {
  assertAdmin(auth);

  const [
    typeSafeSource,
    openRouterConnected,
    vercelGatewayConnected,
    storedSelection,
  ] = await Promise.all([
    resolveTypeSafeKeySource(),
    isOpenRouterConnected(),
    isVercelGatewayConnected(),
    getDeploymentJudgmentModelSelection(),
  ]);
  const envSelection = resolveEnvJudgmentModelSelection();
  const typeSafeConnected = typeSafeSource !== null;
  const roomoteConnected = isRoomoteUpstreamConfigured();
  const effectiveSelection = resolveEffectiveJudgmentModelSelection({
    envSelection,
    storedSelection,
    hasTypeSafeKey: typeSafeConnected,
    hasRoomoteUpstream: roomoteConnected,
  });

  return {
    typeSafe: { connected: typeSafeConnected, source: typeSafeSource },
    openRouterConnected,
    vercelGatewayConnected,
    roomoteConnected,
    storedSelection,
    envSelection,
    effectiveSelection,
    effectiveSelectionUsable:
      effectiveSelection === 'off' ||
      (effectiveSelection === 'roomote' && roomoteConnected) ||
      (effectiveSelection === 'typesafe' && typeSafeConnected) ||
      (effectiveSelection === 'openrouter' && openRouterConnected) ||
      (effectiveSelection === 'vercel' && vercelGatewayConnected),
  };
}

/**
 * One tiny judgment call to check a new TypeSafe key. Only an explicit
 * rejection blocks the save: when TypeSafe is slow or unreachable the key is
 * stored unverified, because judgment callers already fall back to the helper
 * model whenever TypeSafe fails.
 */
async function checkTypeSafeApiKey(
  apiKey: string,
): Promise<TypeSafeKeyCheck | 'rejected'> {
  try {
    const response = await fetch(TYPESAFE_KEY_CHECK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'jev-latest',
        state: 'ping',
        questions: {
          ok: { type: 'noul', instructions: 'Is this a ping?' },
        },
      }),
      signal: AbortSignal.timeout(TYPESAFE_KEY_CHECK_TIMEOUT_MS),
    });

    if (response.status === 401 || response.status === 403) {
      return 'rejected';
    }

    return response.ok ? 'verified' : 'unverified';
  } catch {
    return 'unverified';
  }
}

export async function saveJudgmentTypeSafeKeyCommand(
  auth: UserAuthSuccess,
  input: { apiKey: string },
): Promise<{ keyCheck: TypeSafeKeyCheck; settings: JudgmentModelSettings }> {
  assertAdmin(auth);

  const apiKey = input.apiKey.trim();

  if (!apiKey) {
    throw new Error('Enter a TypeSafe API key.');
  }

  if ((await resolveTypeSafeKeySource()) === 'environment') {
    throw new Error(
      `The TypeSafe API key is managed by ${TYPESAFE_API_KEY_ENV_VAR_NAME} and cannot be changed in Settings.`,
    );
  }

  const keyCheck = await checkTypeSafeApiKey(apiKey);

  if (keyCheck === 'rejected') {
    throw new Error('TypeSafe rejected this API key.');
  }

  // No selection write: with no stored selection, a TypeSafe key alone
  // selects Jev via TypeSafe, and an explicit stored choice is kept.
  await db.transaction(async (tx) => {
    await upsertDeploymentEnvironmentVariables(tx, {
      userId: auth.userId,
      values: [{ name: TYPESAFE_API_KEY_ENV_VAR_NAME, value: apiKey }],
    });
  });

  return { keyCheck, settings: await getJudgmentModelSettingsCommand(auth) };
}

export async function deleteJudgmentTypeSafeKeyCommand(
  auth: UserAuthSuccess,
): Promise<JudgmentModelSettings> {
  assertAdmin(auth);

  const source = await resolveTypeSafeKeySource();

  if (source === 'environment') {
    throw new Error(
      `The TypeSafe API key is managed by ${TYPESAFE_API_KEY_ENV_VAR_NAME} and cannot be removed in Settings.`,
    );
  }

  if (source !== 'settings') {
    throw new Error('TypeSafe does not have a saved API key.');
  }

  // A stored 'typesafe' selection is kept; it becomes unusable (judgment
  // falls back to the helper model) until a key is connected again.
  await db
    .delete(environmentVariables)
    .where(
      and(
        isNull(environmentVariables.userId),
        eq(environmentVariables.name, TYPESAFE_API_KEY_ENV_VAR_NAME),
      ),
    );

  return getJudgmentModelSettingsCommand(auth);
}

export async function setJudgmentModelSelectionCommand(
  auth: UserAuthSuccess,
  input: { selection: JudgmentModelSelection },
): Promise<JudgmentModelSettings> {
  assertAdmin(auth);

  if (resolveEnvJudgmentModelSelection()) {
    throw new Error(
      `The judgment model is managed by ${JUDGMENT_MODEL_ENV_VAR_NAME} and cannot be changed in Settings.`,
    );
  }

  if (input.selection === 'roomote' && !isRoomoteUpstreamConfigured()) {
    throw new Error(
      `Set ${JUDGMENT_UPSTREAM_URL_ENV_VAR_NAME} before choosing ${JUDGMENT_MODEL_SELECTION_LABELS.roomote}.`,
    );
  }

  if (
    input.selection === 'typesafe' &&
    (await resolveTypeSafeKeySource()) === null
  ) {
    throw new Error(
      `Connect TypeSafe before choosing ${JUDGMENT_MODEL_SELECTION_LABELS.typesafe}.`,
    );
  }

  if (input.selection === 'vercel' && !(await isVercelGatewayConnected())) {
    throw new Error(
      `Connect Vercel AI Gateway before choosing ${JUDGMENT_MODEL_SELECTION_LABELS.vercel}.`,
    );
  }

  if (input.selection === 'openrouter' && !(await isOpenRouterConnected())) {
    throw new Error(
      `Connect OpenRouter before choosing ${JUDGMENT_MODEL_SELECTION_LABELS.openrouter}.`,
    );
  }

  await setDeploymentJudgmentModelSelection(input.selection);

  return getJudgmentModelSettingsCommand(auth);
}
