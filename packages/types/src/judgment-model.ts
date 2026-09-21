/**
 * The optional judgment model: a System One evaluation model (TypeSafe's Jev)
 * that answers typed routing and triage questions in one fast call instead of
 * generating text. It is deliberately not a chat model provider or a task
 * model role: it never runs tasks, never appears in chat model pickers, and
 * its credentials never reach the model runtime or a sandbox.
 */

export const TYPESAFE_API_KEY_ENV_VAR_NAME = 'R_TYPESAFE_API_KEY';

/** Selects the judgment model; overrides the Settings choice when set. */
export const JUDGMENT_MODEL_ENV_VAR_NAME = 'R_JUDGMENT_MODEL';

/**
 * A judgment model Roomote runs itself. The upstream speaks the same typed
 * decisions request as Jev (`{state, model, questions}` → `{answers}`), so
 * every caller is unchanged; only where the text goes differs. Hosting
 * injects both values for managed deployments; a self-hosted operator can
 * point them at any compatible server. The key is optional because a
 * private-network upstream may carry no auth at all.
 */
export const JUDGMENT_UPSTREAM_URL_ENV_VAR_NAME = 'R_JUDGMENT_UPSTREAM_URL';

/**
 * Where judgment requests go:
 * - `off`: never use a judgment model.
 * - `typesafe`: Jev through TypeSafe's API with a TypeSafe key.
 * - `openrouter`: Jev (`typesafe/jev-1.13`) through OpenRouter with the
 *   deployment's OpenRouter key.
 * - `vercel`: Jev (`typesafe-ai/jev`) through Vercel AI Gateway with the
 *   deployment's AI Gateway key.
 * - `roomote`: the Roomote-run judgment model at `R_JUDGMENT_UPSTREAM_URL`.
 *   Decision text stays on Roomote-operated infrastructure.
 */
export const JUDGMENT_MODEL_SELECTIONS = [
  'off',
  'roomote',
  'typesafe',
  'openrouter',
  'vercel',
] as const;

export type JudgmentModelSelection = (typeof JUDGMENT_MODEL_SELECTIONS)[number];

export function isJudgmentModelSelection(
  value: unknown,
): value is JudgmentModelSelection {
  return (
    typeof value === 'string' &&
    JUDGMENT_MODEL_SELECTIONS.includes(value as JudgmentModelSelection)
  );
}

export const JUDGMENT_MODEL_SELECTION_LABELS: Record<
  JudgmentModelSelection,
  string
> = {
  off: 'Off',
  roomote: 'Roomote judgment model',
  typesafe: 'Jev via TypeSafe',
  openrouter: 'Jev via OpenRouter',
  vercel: 'Jev via Vercel AI Gateway',
};

export const TYPESAFE_PROVIDER = {
  id: 'typesafe',
  label: 'TypeSafe',
  envVarName: TYPESAFE_API_KEY_ENV_VAR_NAME,
  credentialHelp: {
    label: 'Create a TypeSafe API key',
    url: 'https://typesafe.ai',
  },
} as const;

/**
 * Which backend a deployment uses when no explicit selection exists: a
 * TypeSafe key alone opts in to Jev via TypeSafe, and otherwise a configured
 * Roomote-run upstream is used, because it sends decision text to nowhere
 * the deployment does not already trust. AI Gateway and OpenRouter are never
 * chosen implicitly, because their keys exist on many deployments for task
 * inference and choosing them would send decision text to a third party
 * nobody asked for.
 */
export function resolveEffectiveJudgmentModelSelection(params: {
  envSelection?: string | null;
  storedSelection?: JudgmentModelSelection | null;
  hasTypeSafeKey: boolean;
  hasRoomoteUpstream?: boolean;
}): JudgmentModelSelection {
  if (isJudgmentModelSelection(params.envSelection)) {
    return params.envSelection;
  }

  if (params.storedSelection) {
    return params.storedSelection;
  }

  if (params.hasTypeSafeKey) {
    return 'typesafe';
  }

  return params.hasRoomoteUpstream ? 'roomote' : 'off';
}
