'use client';

import { useState } from 'react';

import { type ReasoningEffort } from '@roomote/types';

import {
  ModelReasoningPicker,
  ModelReasoningPickerTrigger,
} from '@/components/tasks/ModelReasoningPicker';
import { useLaunchTaskModels } from '@/hooks/task-models/useLaunchTaskModels';

/** Session composer model chip, mirroring the task composer's model switcher:
 * a ghost chip with the model and reasoning level that opens a popover with
 * the pickers. */
export function SessionModelSwitcher({
  model,
  onModelChange,
  reasoningEffort,
  onReasoningEffortChange,
  defaultModelId,
  defaultReasoningEffort,
  disabled,
  size = 'compact',
}: {
  model: string;
  onModelChange: (model: string) => void;
  reasoningEffort: ReasoningEffort | null;
  onReasoningEffortChange: (effort: ReasoningEffort | null) => void;
  /** The deployment's effective Fast (orchestration) model. */
  defaultModelId?: string | null;
  defaultReasoningEffort?: ReasoningEffort | null;
  disabled?: boolean;
  size?: 'compact' | 'base';
}) {
  const [open, setOpen] = useState(false);
  const { data } = useLaunchTaskModels();
  const displayModelName = (modelId: string) =>
    data?.models.find(({ id }) => id === modelId)?.displayName ?? modelId;
  const effectiveDefaultModelId =
    defaultModelId ?? data?.defaultFastModelId ?? null;
  const effectiveDefaultEffort =
    defaultReasoningEffort ?? data?.defaultFastReasoningEffort ?? null;
  const effectiveReasoningEffort = reasoningEffort ?? effectiveDefaultEffort;
  const chipLabel = model
    ? displayModelName(model)
    : effectiveDefaultModelId
      ? displayModelName(effectiveDefaultModelId)
      : 'Model';

  const trigger = (
    <ModelReasoningPickerTrigger
      label={chipLabel}
      reasoningEffort={effectiveReasoningEffort}
      disabled={disabled}
      size={size}
      ariaLabel="Model for this session"
    />
  );

  return (
    <ModelReasoningPicker
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      tooltip={size === 'compact' ? 'Model for this session' : undefined}
      models={data?.models ?? []}
      model={model}
      defaultModelId={effectiveDefaultModelId}
      emptyModelLabel={
        effectiveDefaultModelId
          ? `${displayModelName(effectiveDefaultModelId)} (Default)`
          : 'Deployment default'
      }
      onModelChange={onModelChange}
      reasoningEffort={reasoningEffort}
      defaultReasoningEffort={effectiveDefaultEffort}
      onReasoningEffortChange={onReasoningEffortChange}
      disabled={disabled}
    />
  );
}
