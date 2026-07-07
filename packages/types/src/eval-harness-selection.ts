import {
  type HarnessModelOverrides,
  type LaunchCodingHarness,
  type ReasoningEffort,
  isLaunchCodingHarness,
  launchCodingHarnesses,
} from './cloud-jobs';

const OPENCODE_MODEL_PATTERN = /^[^/\s]+\/.+$/u;

/**
 * Resolved harness selection for a Slack `!eval` launch.
 *
 * `ok: false` carries a user-facing usage error suitable for posting back into
 * the Slack thread; `ok: true` carries the optional `task.harness` pin and the
 * worker-read `payload.harnessModelOverrides` to attach to the launch.
 */
export type EvalHarnessSelection =
  | {
      ok: true;
      harness?: LaunchCodingHarness;
      harnessModelOverrides?: HarnessModelOverrides;
    }
  | { ok: false; error: string };

/**
 * Resolves a caller-supplied harness / model / reasoning-effort triplet into a
 * concrete harness pin and model override, validating that the combination is
 * actually runnable. Used by both the Slack `!eval` command (`--harness` /
 * `--model` / `--reasoning` flags) and the programmatic task-launch API
 * (`harness` / `model` / `reasoningEffort` body fields).
 *
 * Rules:
 * - An explicit harness (when present) pins `task.harness`. OpenCode is the
 *   only launch harness for new work.
 * - The model becomes the override for the OpenCode harness. OpenCode accepts
 *   provider/model identifiers from the operator's selected config.
 * - Reasoning effort is not supported by OpenCode, so it is rejected rather
 *   than silently dropped.
 *
 * The function is pure and validation-complete so both surfaces can share it:
 * each calls it to surface errors and to build the launch payload.
 */
export function resolveEvalHarnessSelection(input: {
  harness?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): EvalHarnessSelection {
  const requestedHarness = input.harness?.trim();
  const trimmedModel = input.model?.trim() || undefined;

  let explicitHarness: LaunchCodingHarness | undefined;
  if (requestedHarness) {
    if (!isLaunchCodingHarness(requestedHarness)) {
      return {
        ok: false,
        error: `Unknown harness "${requestedHarness}". Use one of: ${launchCodingHarnesses.join(', ')}.`,
      };
    }
    explicitHarness = requestedHarness;
  }

  // Explicit harness wins; otherwise infer OpenCode from a model override and
  // leave the harness implicit so the launch payload stays minimal.
  const effectiveHarness: LaunchCodingHarness | undefined =
    explicitHarness ?? (trimmedModel ? 'opencode-server' : undefined);

  if (input.reasoningEffort) {
    return {
      ok: false,
      error:
        'Reasoning effort is not supported on the OpenCode harness; omit it when targeting opencode-server.',
    };
  }

  if (trimmedModel) {
    if (!OPENCODE_MODEL_PATTERN.test(trimmedModel)) {
      return {
        ok: false,
        error: `Model "${trimmedModel}" must use OpenCode provider/model format.`,
      };
    }
  }

  const harnessModelOverrides: HarnessModelOverrides | undefined = !trimmedModel
    ? undefined
    : { 'opencode-server': trimmedModel };

  return {
    ok: true,
    ...(effectiveHarness ? { harness: effectiveHarness } : {}),
    ...(harnessModelOverrides ? { harnessModelOverrides } : {}),
  };
}
