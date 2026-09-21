'use client';

import { toast } from 'sonner';
import {
  isJudgmentModelSelection,
  JUDGMENT_MODEL_ENV_VAR_NAME,
  JUDGMENT_MODEL_SELECTION_LABELS,
  JUDGMENT_MODEL_SELECTIONS,
  type JudgmentModelSelection,
} from '@roomote/types';

import {
  BasicTooltip,
  Lock,
  Scale,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@/components/system';
import { useJudgmentModelSettings } from '@/hooks/task-models/useJudgmentModelSettings';
import { useSetJudgmentModelSelection } from '@/hooks/task-models/useSetJudgmentModelSelection';

const JUDGMENT_MODEL_LABEL = 'Judgment model';

const JUDGMENT_MODEL_DESCRIPTION =
  'Makes quick routing and triage decisions (which channel messages start work, which skill or tool fits, whether a reply is for Roomote). Anything it is unsure about falls back to the helper model.';

const MISSING_PROVIDER_HINTS: Record<
  Exclude<JudgmentModelSelection, 'off'>,
  string
> = {
  typesafe: 'Connect TypeSafe',
  openrouter: 'Connect OpenRouter',
  vercel: 'Connect Vercel AI Gateway',
};

const UNUSABLE_SELECTION_MESSAGES: Record<
  Exclude<JudgmentModelSelection, 'off'>,
  string
> = {
  typesafe:
    'TypeSafe is not connected, so these decisions use the helper model.',
  openrouter:
    'OpenRouter is not connected, so these decisions use the helper model.',
  vercel:
    'Vercel AI Gateway is not connected, so these decisions use the helper model.',
};

/**
 * The judgment model row in Settings > Models > Model mapping. It sits with
 * the task model roles but is not one: it saves immediately through its own
 * procedure and never joins the model settings form or runtime model config.
 */
export function JudgmentModelRow() {
  const settingsQuery = useJudgmentModelSettings();
  const setSelection = useSetJudgmentModelSelection();
  const settings = settingsQuery.data;
  const managedByEnv = Boolean(settings?.envSelection);

  const isProviderConnected = (selection: JudgmentModelSelection) => {
    if (!settings) {
      return false;
    }

    switch (selection) {
      case 'off':
        return true;
      case 'typesafe':
        return settings.typeSafe.connected;
      case 'openrouter':
        return settings.openRouterConnected;
      case 'vercel':
        return settings.vercelGatewayConnected;
    }
  };

  const handleChange = async (value: string) => {
    if (
      !isJudgmentModelSelection(value) ||
      value === settings?.effectiveSelection
    ) {
      return;
    }

    try {
      await setSelection.mutateAsync({ selection: value });
      toast.success(
        `Judgment model set to ${JUDGMENT_MODEL_SELECTION_LABELS[value]}.`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Could not update the judgment model.',
      );
    }
  };

  const effectiveSelection = settings?.effectiveSelection;
  const unusableMessage =
    settings && !settings.effectiveSelectionUsable && effectiveSelection
      ? effectiveSelection === 'off'
        ? null
        : UNUSABLE_SELECTION_MESSAGES[effectiveSelection]
      : null;

  return (
    <div className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <Scale className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{JUDGMENT_MODEL_LABEL}</span>
            {managedByEnv && (
              <BasicTooltip
                content={`Set by ${JUDGMENT_MODEL_ENV_VAR_NAME}, not changeable in the UI.`}
              >
                <span
                  aria-label={`${JUDGMENT_MODEL_LABEL} is managed by ${JUDGMENT_MODEL_ENV_VAR_NAME}`}
                  className="inline-flex text-muted-foreground"
                >
                  <Lock className="size-3.5" />
                </span>
              </BasicTooltip>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {JUDGMENT_MODEL_DESCRIPTION}
          </p>
        </div>

        {settingsQuery.isPending ? (
          <Skeleton className="h-9 w-full sm:max-w-sm" />
        ) : !settings ? (
          <p className="text-sm text-destructive">
            Failed to load judgment model settings.
          </p>
        ) : (
          <>
            <Select
              value={settings.effectiveSelection}
              onValueChange={(value) => void handleChange(value)}
              disabled={managedByEnv || setSelection.isPending}
            >
              <SelectTrigger
                className="w-full sm:max-w-sm"
                aria-label={JUDGMENT_MODEL_LABEL}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {JUDGMENT_MODEL_SELECTIONS.map((selection) => {
                  const connected = isProviderConnected(selection);

                  return (
                    <SelectItem
                      key={selection}
                      value={selection}
                      disabled={!connected}
                    >
                      {JUDGMENT_MODEL_SELECTION_LABELS[selection]}
                      {!connected && selection !== 'off' ? (
                        <span className="text-xs text-muted-foreground">
                          {MISSING_PROVIDER_HINTS[selection]}
                        </span>
                      ) : null}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {unusableMessage ? (
              <p className="text-xs text-destructive">{unusableMessage}</p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
