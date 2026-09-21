'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  ArrowDownIcon,
  ArrowRight,
  BasicTooltip,
  Button,
  ChevronDown,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  Plus,
  Trash2,
} from '@/components/system';
import {
  ModelReasoningPicker,
  ModelReasoningPickerTrigger,
  type ModelReasoningPickerModel,
} from '@/components/tasks/ModelReasoningPicker';
import { type EditableRuntimeModelOption } from './TaskModelSelect';
import {
  MAX_CODING_MODEL_ROUTING_RULES,
  type CodingModelRoutingRule,
  type DisplayModelProviderGroup,
  type ReasoningEffort,
  type TaskModelMetadata,
} from '@roomote/types';

export type CodingModelRoutingRulesDraft = CodingModelRoutingRule[];

export type CodingModelRoutingRulesChange = {
  rules: CodingModelRoutingRulesDraft;
  saveDelayMs: number | null;
  suppressSuccessToast: boolean;
};

type RoutingModel = {
  id: string;
  metadata?: TaskModelMetadata | null;
};

export function cloneCodingModelRoutingRules(
  rules: CodingModelRoutingRulesDraft,
): CodingModelRoutingRulesDraft {
  return rules.map((rule) => ({ ...rule }));
}

export function codingModelRoutingRulesEqual(
  left: CodingModelRoutingRulesDraft,
  right: CodingModelRoutingRulesDraft,
): boolean {
  return (
    left.length === right.length &&
    left.every((rule, index) => {
      const otherRule = right[index];
      return (
        otherRule !== undefined &&
        rule.modelId === otherRule.modelId &&
        rule.reasoningEffort === otherRule.reasoningEffort &&
        rule.condition === otherRule.condition
      );
    })
  );
}

export function prepareCodingModelRoutingRulesForSave(
  rules: CodingModelRoutingRulesDraft,
): CodingModelRoutingRule[] {
  return rules.filter((rule) => rule.condition.trim().length > 0);
}

export function removeModelFromCodingModelRoutingRules(
  rules: CodingModelRoutingRulesDraft,
  modelId: string,
): CodingModelRoutingRulesDraft {
  return rules.filter((rule) => rule.modelId !== modelId);
}

function supportsReasoning(models: RoutingModel[], modelId: string): boolean {
  return (
    models.find((model) => model.id === modelId)?.metadata
      ?.supportsReasoning !== false
  );
}

function RoutingRuleEditorRow({
  index,
  rule,
  pickerModels,
  models,
  updateRule,
  removeRule,
}: {
  index: number;
  rule: CodingModelRoutingRule;
  pickerModels: ModelReasoningPickerModel[];
  models: RoutingModel[];
  updateRule: (index: number, rule: CodingModelRoutingRule) => void;
  removeRule: (index: number) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pendingModelIdRef = useRef(rule.modelId);
  const selectedModel = pickerModels.find(({ id }) => id === rule.modelId);
  const modelSupportsReasoning = supportsReasoning(models, rule.modelId);

  useEffect(() => {
    pendingModelIdRef.current = rule.modelId;
  }, [rule.modelId]);

  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center">
      <Input
        value={rule.condition}
        onChange={(event) =>
          updateRule(index, {
            ...rule,
            condition: event.target.value,
          })
        }
        aria-label={`Routing rule ${index + 1} condition`}
        placeholder="When should this model be used?"
        className="min-w-0 flex-1"
      />
      <ArrowDownIcon className="ml-8 size-4 shrink-0 self-start text-muted-foreground md:hidden" />
      <ArrowRight className="hidden size-4 shrink-0 self-center text-muted-foreground md:block" />
      <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <ModelReasoningPicker
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            trigger={
              <ModelReasoningPickerTrigger
                label={selectedModel?.displayName ?? rule.modelId}
                reasoningEffort={
                  modelSupportsReasoning
                    ? (rule.reasoningEffort ?? 'medium')
                    : null
                }
                appearance="select"
                ariaLabel={`Routing rule ${index + 1} model and reasoning`}
              />
            }
            models={pickerModels}
            model={rule.modelId}
            onModelChange={(modelId) => {
              pendingModelIdRef.current = modelId;
              updateRule(index, {
                ...rule,
                modelId,
                reasoningEffort: supportsReasoning(models, modelId)
                  ? (rule.reasoningEffort ?? 'medium')
                  : null,
              });
            }}
            reasoningEffort={rule.reasoningEffort}
            defaultReasoningEffort="medium"
            onReasoningEffortChange={(reasoningEffort) =>
              updateRule(index, {
                ...rule,
                modelId: pendingModelIdRef.current,
                reasoningEffort,
              })
            }
          />
        </div>
        <BasicTooltip content="Remove routing rule">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0 text-muted-foreground"
            aria-label={`Remove routing rule ${index + 1}`}
            onClick={() => removeRule(index)}
          >
            <Trash2 />
          </Button>
        </BasicTooltip>
      </div>
    </div>
  );
}

export function CodingModelRoutingRulesEditor({
  rules,
  optionGroups,
  models,
  defaultModelId,
  defaultReasoningEffort,
  onChange,
}: {
  rules: CodingModelRoutingRulesDraft;
  optionGroups: DisplayModelProviderGroup<EditableRuntimeModelOption>[];
  models: RoutingModel[];
  defaultModelId: string | null;
  defaultReasoningEffort: ReasoningEffort | null;
  onChange: (change: CodingModelRoutingRulesChange) => void;
}) {
  const [open, setOpen] = useState(false);
  const pickerModels = useMemo(
    () =>
      optionGroups.flatMap((group) =>
        group.items.map((item) => ({
          ...item,
          providerLabel: group.label,
        })),
      ),
    [optionGroups],
  );

  const updateRule = (index: number, rule: CodingModelRoutingRule) => {
    onChange({
      rules: rules.map((currentRule, currentIndex) =>
        currentIndex === index ? rule : currentRule,
      ),
      saveDelayMs: 400,
      suppressSuccessToast: true,
    });
  };

  const addRule = () => {
    if (!defaultModelId) return;

    onChange({
      rules: [
        ...rules,
        {
          modelId: defaultModelId,
          reasoningEffort: supportsReasoning(models, defaultModelId)
            ? (defaultReasoningEffort ?? 'medium')
            : null,
          condition: '',
        },
      ],
      saveDelayMs: null,
      suppressSuccessToast: false,
    });
  };

  const removeRule = (index: number) => {
    onChange({
      rules: rules.filter((_, currentIndex) => currentIndex !== index),
      saveDelayMs: 0,
      suppressSuccessToast: false,
    });
  };

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={`space-y-3 ${open ? 'pb-3' : ''}`}
    >
      <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1.5 text-left text-sm text-muted-foreground hover:text-foreground">
        <ChevronDown
          className="size-4 shrink-0 transition-transform"
          style={{ transform: open ? undefined : 'rotate(-90deg)' }}
        />
        Custom coding model routing rules
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3">
        {rules.length > 0 ? (
          <div className="space-y-2">
            {rules.map((rule, index) => (
              <RoutingRuleEditorRow
                key={index}
                index={index}
                rule={rule}
                pickerModels={pickerModels}
                models={models}
                updateRule={updateRule}
                removeRule={removeRule}
              />
            ))}
          </div>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-4"
          disabled={rules.length >= MAX_CODING_MODEL_ROUTING_RULES}
          onClick={addRule}
        >
          <Plus />
          Add a model routing rule
        </Button>
      </CollapsibleContent>
    </Collapsible>
  );
}
