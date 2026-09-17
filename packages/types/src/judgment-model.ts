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
 * Where judgment requests go:
 * - `off`: never use a judgment model.
 * - `typesafe`: Jev through TypeSafe's API with a TypeSafe key.
 * - `vercel`: Jev (`typesafe-ai/jev`) through Vercel AI Gateway with the
 *   deployment's AI Gateway key.
 */
export const JUDGMENT_MODEL_SELECTIONS = ['off', 'typesafe', 'vercel'] as const;

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
  typesafe: 'Jev via TypeSafe',
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
 * TypeSafe key alone opts in to Jev via TypeSafe. AI Gateway is never chosen
 * implicitly, because its key exists on many deployments for task inference.
 */
export function resolveEffectiveJudgmentModelSelection(params: {
  envSelection?: string | null;
  storedSelection?: JudgmentModelSelection | null;
  hasTypeSafeKey: boolean;
}): JudgmentModelSelection {
  if (isJudgmentModelSelection(params.envSelection)) {
    return params.envSelection;
  }

  if (params.storedSelection) {
    return params.storedSelection;
  }

  return params.hasTypeSafeKey ? 'typesafe' : 'off';
}
