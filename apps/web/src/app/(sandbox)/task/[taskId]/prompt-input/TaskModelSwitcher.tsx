'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  DEFAULT_MODEL_ROLE_REASONING_EFFORTS,
  getHarnessModelOverride,
  getReasoningEffortLabel,
  getTaskModelDisplayName,
  type ReasoningEffort,
  type TaskModelOverrideRole,
  type TaskModelRoleOverride,
} from '@roomote/types';

import {
  BasicTooltip,
  Button,
  ChevronDown,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/system';
import { ModelSelect } from '@/components/tasks/ModelSelect';
import { ReasoningEffortSelect } from '@/components/tasks/ReasoningEffortSelect';
import { useLaunchTaskModels } from '@/hooks/task-models/useLaunchTaskModels';
import type { TaskRunDetail } from '@/lib/server/task-runs';
import { useTRPC } from '@/trpc/client';

type SwitcherRole = 'coding' | TaskModelOverrideRole;

const OVERRIDE_ROLE_ROWS: Array<{
  role: TaskModelOverrideRole;
  label: string;
}> = [
  { role: 'planning', label: 'Planning' },
  { role: 'codeReview', label: 'Code review' },
  { role: 'explore', label: 'Explore' },
  { role: 'helper', label: 'Helper' },
  { role: 'vision', label: 'Vision' },
];

type RoleSelection = {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
};

/**
 * Per-task model switcher rendered in the task composer footer. Shows the
 * coding model up front; the other model roles live behind the "All roles"
 * expander. Every change persists to the run and applies from the next
 * message.
 */
export function TaskModelSwitcher({
  taskRun,
  disabled = false,
}: {
  taskRun: TaskRunDetail;
  disabled?: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [showAllRoles, setShowAllRoles] = useState(false);
  // Selections applied locally while the mutation + session refetch settle,
  // so the pickers do not snap back between change and refresh.
  const [localSelections, setLocalSelections] = useState<
    Partial<Record<SwitcherRole, RoleSelection>>
  >({});

  const { data: roleDefaults } = useQuery(
    trpc.taskModels.roleDefaults.queryOptions(undefined, { enabled: open }),
  );
  const { data: launchModels } = useLaunchTaskModels();
  const modelDisplayNames = useMemo(
    () =>
      new Map(
        (launchModels?.models ?? []).map((model) => [
          model.id,
          model.displayName,
        ]),
      ),
    [launchModels?.models],
  );
  // Alias-provider ids (bedrock-mantle/..., subscription aliases) are not in
  // the launch catalog under their runtime id; the generic formatter is the
  // fallback for those.
  const displayModelName = (modelId: string) =>
    modelDisplayNames.get(modelId) ?? getTaskModelDisplayName(modelId);

  const payloadCodingModel = getHarnessModelOverride(
    taskRun.payload?.harnessModelOverrides,
    'opencode-server',
  );
  const payloadCodingEffort = taskRun.payload?.reasoningEffort ?? null;
  const payloadRoleOverrides = taskRun.payload?.modelRoleOverrides;

  // Server state is the source of truth: whenever the session payload
  // reflects new model settings (our own write landing, or an external
  // change such as the agent's update_models tool), drop the local optimistic
  // selections so the pickers track it.
  const payloadStateKey = JSON.stringify([
    payloadCodingModel ?? null,
    payloadCodingEffort,
    payloadRoleOverrides ?? null,
  ]);

  useEffect(() => {
    setLocalSelections({});
  }, [payloadStateKey]);

  const invalidateSession = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.sandboxSession.byTaskId.queryKey({
        taskId: taskRun.taskId,
      }),
    });

  const updateModelSelection = useMutation(
    trpc.sandboxSession.updateTaskModelSelection.mutationOptions({
      onSuccess: (result) => {
        void invalidateSession();

        if (result.application === 'restarted') {
          toast.success('Model settings updated');
        } else if (result.application === 'deferred') {
          toast.success('Model settings updated for the next message');
        } else {
          toast.success('Model settings saved for when the task resumes');
        }
      },
      onError: (error, variables) => {
        setLocalSelections((current) => {
          const next = { ...current };

          delete next[variables.role as SwitcherRole];
          return next;
        });
        toast.error(error.message || 'Failed to update the model settings');
      },
    }),
  );

  // Toast-free twin of `updateModelSelection` for the reset loop, which
  // reports a single outcome after the last role clears.
  const resetModelSelection = useMutation(
    trpc.sandboxSession.updateTaskModelSelection.mutationOptions(),
  );

  const applyRoleSelection = (role: SwitcherRole, selection: RoleSelection) => {
    setLocalSelections((current) => ({ ...current, [role]: selection }));
    updateModelSelection.mutate({
      taskId: taskRun.taskId,
      role,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
    });
  };

  const resolveRoleSelection = (role: TaskModelOverrideRole): RoleSelection => {
    const local = localSelections[role];

    if (local) {
      return local;
    }

    const override: TaskModelRoleOverride | undefined =
      payloadRoleOverrides?.[role];

    return {
      model: override?.model ?? null,
      reasoningEffort: override?.reasoningEffort ?? null,
    };
  };

  const codingSelection: RoleSelection = localSelections.coding ?? {
    model: payloadCodingModel ?? null,
    reasoningEffort: payloadCodingEffort,
  };
  const effectiveCodingModel =
    codingSelection.model ?? roleDefaults?.defaultModelId ?? null;
  const effectiveCodingEffort =
    codingSelection.reasoningEffort ??
    roleDefaults?.roles.coding.reasoningEffort ??
    DEFAULT_MODEL_ROLE_REASONING_EFFORTS.coding;

  const hasRoleOverrides = useMemo(
    () =>
      OVERRIDE_ROLE_ROWS.some(({ role }) => {
        const selection = resolveRoleSelection(role);

        return selection.model !== null || selection.reasoningEffort !== null;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [localSelections, payloadRoleOverrides],
  );

  const chipLabel = effectiveCodingModel
    ? displayModelName(effectiveCodingModel)
    : 'Model';

  const [resetting, setResetting] = useState(false);

  // Reset clears roles sequentially: firing the per-role mutations
  // concurrently would race their payload read-modify-writes (the server
  // also row-locks, but sequencing keeps the toasts to one and the sandbox
  // restarts collapsed), and each role only needs a call when it actually
  // holds an override.
  const handleReset = async () => {
    const rolesToClear: SwitcherRole[] = [
      'coding',
      ...OVERRIDE_ROLE_ROWS.filter(({ role }) => {
        const selection = resolveRoleSelection(role);

        return selection.model !== null || selection.reasoningEffort !== null;
      }).map(({ role }) => role),
    ];
    const cleared: RoleSelection = { model: null, reasoningEffort: null };

    setResetting(true);
    setLocalSelections(
      Object.fromEntries(rolesToClear.map((role) => [role, cleared])),
    );

    try {
      let application: string = 'offline';

      for (const role of rolesToClear) {
        const result = await resetModelSelection.mutateAsync({
          taskId: taskRun.taskId,
          role,
          model: null,
          reasoningEffort: null,
        });

        application = result.application;
      }

      if (application === 'restarted') {
        toast.success('Model settings reset');
      } else if (application === 'deferred') {
        toast.success('Model settings reset for the next message');
      } else {
        toast.success('Model settings reset for when the task resumes');
      }
    } catch (error) {
      setLocalSelections({});
      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to reset the model settings',
      );
    } finally {
      setResetting(false);
      void invalidateSession();
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <BasicTooltip content="Models for this task">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:bg-secondary h-8 gap-1 px-2 text-xs font-normal"
            aria-label="Models for this task"
          >
            <span className="max-w-40 truncate">{chipLabel}</span>
            <span className="text-muted-foreground/70">
              {getReasoningEffortLabel(effectiveCodingEffort)}
            </span>
            {hasRoleOverrides && (
              <span
                className="bg-primary size-1.5 shrink-0 rounded-full"
                aria-label="Some roles are customized"
              />
            )}
            <ChevronDown className="size-3 shrink-0" />
          </Button>
        </PopoverTrigger>
      </BasicTooltip>
      <PopoverContent align="start" className="w-96 p-3">
        <div className="space-y-3">
          <p className="text-sm font-medium">Models for this task</p>

          <div className="flex items-center gap-2">
            <ModelSelect
              value={effectiveCodingModel ?? undefined}
              onValueChange={(model) => {
                if (!model) {
                  return;
                }

                applyRoleSelection('coding', {
                  model,
                  reasoningEffort: codingSelection.reasoningEffort,
                });
              }}
              disabled={disabled}
              className="min-w-0 flex-1"
              ariaLabel="Coding model"
            />
            <ReasoningEffortSelect
              value={codingSelection.reasoningEffort}
              defaultEffort={effectiveCodingEffort}
              onChange={(effort) => {
                if (!effort) {
                  return;
                }

                applyRoleSelection('coding', {
                  model: codingSelection.model,
                  reasoningEffort: effort,
                });
              }}
              disabled={disabled}
              ariaLabel="Coding reasoning level"
              className="w-28 shrink-0"
              size="sm"
            />
          </div>

          <Collapsible open={showAllRoles} onOpenChange={setShowAllRoles}>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground h-7 gap-1 px-1 text-xs"
              >
                <ChevronDown
                  className={`size-3 transition-transform ${showAllRoles ? '' : '-rotate-90'}`}
                />
                All roles
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 space-y-2">
                {OVERRIDE_ROLE_ROWS.map(({ role, label }) => {
                  const selection = resolveRoleSelection(role);
                  const roleDefault = roleDefaults?.roles[role];
                  const defaultModelName = roleDefault?.effectiveModelId
                    ? displayModelName(roleDefault.effectiveModelId)
                    : 'same as coding';
                  const isOverridden =
                    selection.model !== null ||
                    selection.reasoningEffort !== null;

                  return (
                    <div key={role} className="flex items-center gap-2">
                      <span className="text-muted-foreground flex w-24 shrink-0 items-center gap-1.5 text-xs">
                        {label}
                        {isOverridden && (
                          <span
                            className="bg-primary size-1.5 shrink-0 rounded-full"
                            aria-label="Customized"
                          />
                        )}
                      </span>
                      <ModelSelect
                        value={selection.model ?? ''}
                        onValueChange={(model) =>
                          applyRoleSelection(role, {
                            model: model || null,
                            reasoningEffort: selection.reasoningEffort,
                          })
                        }
                        disabled={disabled}
                        className="min-w-0 flex-1"
                        ariaLabel={`${label} model`}
                        emptyOptionLabel={`Default (${defaultModelName})`}
                      />
                      <ReasoningEffortSelect
                        value={selection.reasoningEffort}
                        defaultEffort={
                          roleDefault?.reasoningEffort ??
                          DEFAULT_MODEL_ROLE_REASONING_EFFORTS[role]
                        }
                        onChange={(effort) => {
                          if (!effort) {
                            return;
                          }

                          applyRoleSelection(role, {
                            model: selection.model,
                            reasoningEffort: effort,
                          });
                        }}
                        disabled={disabled}
                        ariaLabel={`${label} reasoning level`}
                        className="w-24 shrink-0"
                        size="sm"
                      />
                    </div>
                  );
                })}
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className="border-border flex items-center justify-between border-t pt-2">
            <span className="text-muted-foreground text-xs">
              Applies from the next message
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => void handleReset()}
              disabled={disabled || resetting}
            >
              {resetting ? 'Resetting…' : 'Reset to defaults'}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
