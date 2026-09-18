'use client';

import { useState } from 'react';

import { getReasoningEffortLabel, type ReasoningEffort } from '@roomote/types';

import {
  BasicTooltip,
  Button,
  ChevronDown,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/system';
import { ModelSelect } from '@/components/tasks/ModelSelect';
import { ReasoningEffortSelect } from '@/components/tasks/ReasoningEffortSelect';
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
}: {
  model: string;
  onModelChange: (model: string) => void;
  reasoningEffort: ReasoningEffort | null;
  onReasoningEffortChange: (effort: ReasoningEffort | null) => void;
  /** The deployment's effective Fast (orchestration) model. */
  defaultModelId?: string | null;
  defaultReasoningEffort?: ReasoningEffort | null;
  disabled?: boolean;
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <BasicTooltip content="Model for this session">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:bg-secondary h-8 gap-1 px-1! text-xs font-normal"
            aria-label="Model for this session"
            disabled={disabled}
          >
            <span className="max-w-40 truncate">{chipLabel}</span>
            {effectiveReasoningEffort ? (
              <span className="text-muted-foreground/70">
                {getReasoningEffortLabel(effectiveReasoningEffort)}
              </span>
            ) : null}
            <ChevronDown className="size-3 shrink-0" />
          </Button>
        </PopoverTrigger>
      </BasicTooltip>
      <PopoverContent align="start" className="w-sm p-3 md:w-xl">
        <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-2">
          <ModelSelect
            value={model}
            onValueChange={onModelChange}
            emptyOptionLabel={
              effectiveDefaultModelId
                ? `Default (${displayModelName(effectiveDefaultModelId)})`
                : 'Deployment default'
            }
            disabled={disabled}
            className="w-full min-w-0"
            ariaLabel="Session model"
          />
          <ReasoningEffortSelect
            value={reasoningEffort}
            defaultEffort={effectiveDefaultEffort}
            onChange={onReasoningEffortChange}
            disabled={disabled}
            ariaLabel="Session reasoning level"
            className="w-full"
            size="sm"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
