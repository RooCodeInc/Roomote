'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  ACP_ENVELOPE_EVENT_TYPES,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
  type AcpMessage,
  type TaskMessageContentBlock,
} from '@roomote/types';

import { useEnvVars } from '@/hooks/environment-variables';
import { useAuthorizedUser } from '@/hooks/useUser';
import type { TaskMessageEnvelope } from '@/types';
import { useTRPC, useTRPCClient } from '@/trpc/client';

import {
  Button,
  Input,
  Label,
  Loader2,
  Lock,
  MessageSquareCode,
  TriangleAlert,
  X,
} from '@/components/system';

import {
  ENV_VAR_REQUEST_FULFILLED_CLIENT_MESSAGE_ID_PREFIX,
  useSandboxAppendAcpEvent,
  useFulfillTaskEnvVarRequest,
  useSandboxClient,
  useTaskEnvVarRequest,
} from './hooks';

interface PendingEnvVarRequestPanelProps {
  taskId: string;
}

const SAFE_FOLLOW_UP_PROMPT =
  'The requested environment variables are now configured for this workspace. Retry the blocked checks without printing secret values, and restart any long-lived processes if needed.';
const MASKED_VALUE = '••••••••••••••••••••••••••••';

function createHiddenEnvVarFulfillmentEvent({
  clientMessageId,
}: {
  clientMessageId: string;
}): AcpMessage {
  const payload = {
    clientMessageId,
    visibleInTranscript: false,
    prompt: [] as TaskMessageContentBlock[],
    content: null,
  };
  const now = Date.now();

  return {
    id: `local:${clientMessageId}`,
    ts: now,
    eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
    role: 'user',
    kind: 'text',
    contentBlocks: [],
    metadata: { visibleInTranscript: false },
    payload,
    visibleInTranscript: false,
  };
}

function createHiddenEnvVarFulfillmentMessage({
  taskId,
  event,
}: {
  taskId: string;
  event: AcpMessage;
}): TaskMessageEnvelope {
  return {
    id: event.id,
    userId: null,
    userName: null,
    userEmail: null,
    userImageUrl: null,
    taskId,
    ts: event.ts,
    createdAt: event.ts,
    sequence: null,
    eventType: event.eventType,
    role: event.role,
    kind: event.kind,
    protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
    contentBlocks: event.contentBlocks,
    metadata: event.metadata,
    payload: event.payload,
    visibleInTranscript: false,
  };
}

export function PendingEnvVarRequestPanel({
  taskId,
}: PendingEnvVarRequestPanelProps) {
  const { isAdmin } = useAuthorizedUser();
  const client = useSandboxClient();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const appendAcpEvent = useSandboxAppendAcpEvent();
  const { data: deploymentEnvVars = [] } = useEnvVars({ enabled: isAdmin });
  const request = useTaskEnvVarRequest(taskId);
  const fulfillRequest = useFulfillTaskEnvVarRequest(taskId);

  const [values, setValues] = useState<Record<string, string>>({});
  const [revealedVariables, setRevealedVariables] = useState<
    Record<string, boolean>
  >({});
  const [dismissedRequestKey, setDismissedRequestKey] = useState<string | null>(
    null,
  );

  const visibleRequest =
    request && request.key !== dismissedRequestKey ? request : null;

  useEffect(() => {
    if (!visibleRequest) {
      setValues({});
      setRevealedVariables({});
      return;
    }

    setValues((currentValues) =>
      Object.fromEntries(
        visibleRequest.variables.map((variable) => [
          variable.name,
          currentValues[variable.name] ?? '',
        ]),
      ),
    );
    setRevealedVariables((currentRevealedValues) =>
      Object.fromEntries(
        visibleRequest.variables.map((variable) => [
          variable.name,
          currentRevealedValues[variable.name] ?? false,
        ]),
      ),
    );
  }, [visibleRequest]);

  const configuredVariableNameSet = useMemo(
    () => new Set(deploymentEnvVars.map((envVar) => envVar.name)),
    [deploymentEnvVars],
  );

  const isConfiguredVariable = (name: string) =>
    configuredVariableNameSet.has(name);

  const isShowingConfiguredMask = (name: string) =>
    isConfiguredVariable(name) &&
    !revealedVariables[name] &&
    (values[name] ?? '').length === 0;

  if (!visibleRequest) {
    return null;
  }

  const recordFulfillmentLocally = (clientMessageId: string) => {
    const event = createHiddenEnvVarFulfillmentEvent({ clientMessageId });
    const message = createHiddenEnvVarFulfillmentMessage({ taskId, event });

    appendAcpEvent(event);
    queryClient.setQueryData<TaskMessageEnvelope[] | undefined>(
      trpc.tasks.messageEnvelopes.queryKey({ taskId }),
      (current) => (current ? [...current, message] : current),
    );
  };

  const handleSubmit = async () => {
    try {
      const requestedNames = visibleRequest.variables.map(
        (variable) => variable.name,
      );
      const clientMessageId = `${
        ENV_VAR_REQUEST_FULFILLED_CLIENT_MESSAGE_ID_PREFIX
      }${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;

      const result = await fulfillRequest.mutateAsync({
        taskId,
        clientMessageId,
        names: requestedNames,
        values: requestedNames.flatMap((name) => {
          const value = values[name] ?? '';

          if (value.trim().length === 0) {
            return [];
          }

          return [{ name, value }];
        }),
      });

      if (!result.canReload || !client) {
        recordFulfillmentLocally(clientMessageId);
        setValues({});
        setRevealedVariables({});
        setDismissedRequestKey(visibleRequest.key);
        toast.success(
          'Environment variables saved. Resume or rerun the task to let the agent continue.',
        );
        return;
      }

      await client.commands.reloadDeploymentEnvVars.mutate();
      let sentFollowUpPrompt = true;

      try {
        await trpcClient.sandboxSession.sendPrompt.mutate({
          taskId,
          prompt: SAFE_FOLLOW_UP_PROMPT,
          source: 'web',
          clientMessageId,
        });
      } catch (error) {
        sentFollowUpPrompt = false;
        console.warn(
          'Saved environment variables, but failed to send the task follow-up prompt.',
          error,
        );

        // The follow-up prompt (which would have persisted the durable
        // fulfillment envelope) failed, so record that envelope directly.
        // Without this, a reconnect or history refetch rebuilds the pending
        // request from persisted envelopes and resurfaces it even though the
        // values were already saved.
        try {
          await trpcClient.taskEnvVarRequests.markFulfilled.mutate({
            taskId,
            clientMessageId,
          });
        } catch (markError) {
          console.warn(
            'Failed to persist the env-var fulfillment marker after the follow-up prompt failed.',
            markError,
          );
        }
      }

      recordFulfillmentLocally(clientMessageId);
      setValues({});
      setRevealedVariables({});
      setDismissedRequestKey(visibleRequest.key);

      if (!sentFollowUpPrompt) {
        toast.success(
          'Environment variables saved. The task is reconnecting, so ask the agent to continue once it is connected.',
        );
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to save environment variables',
      );
    }
  };

  return (
    <div className="min-h-80 md:min-h-auto border-b border-background">
      <div className="mx-auto w-full max-w-4xl p-4 text-foreground">
        <div className="md:space-y-2">
          <div className="flex items-start justify-between gap-3 mb-2 md:mb-0">
            <div className="flex items-center gap-2">
              <MessageSquareCode className="hidden md:inline size-4 text-muted-foreground" />
              <span className="font-semibold text-sm text-foreground">
                I need some environment variables to finish
              </span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setDismissedRequestKey(visibleRequest.key)}
              aria-label="Dismiss environment variable request"
              title="Dismiss environment variable request"
            >
              <X className="size-4" />
            </Button>
          </div>

          {!isAdmin ? (
            <div className="inline-flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive">
              <TriangleAlert className="size-3.5" />
              <span>Admin required</span>
            </div>
          ) : null}

          <div className="overflow-hidden">
            {visibleRequest.variables.map((variable, index) => {
              const value = values[variable.name] ?? '';
              const hasSavedValue = isConfiguredVariable(variable.name);
              const needsValue = !hasSavedValue && value.length === 0;
              return (
                <Label
                  key={variable.name}
                  className={`py-1 flex flex-col items-start md:grid md:gap-2 md:grid-cols-3 md:items-center ${
                    index > 0 ? 'border-t' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold">
                      {variable.name}
                    </span>
                    <TriangleAlert
                      className={`size-4 shrink-0 text-red-600 transition-opacity opacity-${needsValue ? '100' : '0'}`}
                    />
                  </div>

                  <div className="col-span-2 space-y-1">
                    <Input
                      secret
                      value={
                        isShowingConfiguredMask(variable.name)
                          ? MASKED_VALUE
                          : value
                      }
                      onFocus={() => {
                        if (!isShowingConfiguredMask(variable.name)) {
                          return;
                        }

                        setRevealedVariables((currentRevealedValues) => ({
                          ...currentRevealedValues,
                          [variable.name]: true,
                        }));
                      }}
                      onBlur={() => {
                        if (!isConfiguredVariable(variable.name)) {
                          return;
                        }

                        if ((values[variable.name] ?? '').length > 0) {
                          return;
                        }

                        setRevealedVariables((currentRevealedValues) => ({
                          ...currentRevealedValues,
                          [variable.name]: false,
                        }));
                      }}
                      onChange={(event) =>
                        setValues((currentValues) => ({
                          ...currentValues,
                          [variable.name]: event.target.value,
                        }))
                      }
                      placeholder={`Value for ${variable.name}`}
                      disabled={!isAdmin || fulfillRequest.isPending}
                      className="text-xs"
                      data-1p-ignore
                    />
                  </div>
                </Label>
              );
            })}
          </div>

          {isAdmin ? (
            <div className="mt-2 flex flex-col md:flex-row gap-2 md:gap-4 md:items-center">
              <Button
                type="button"
                size="sm"
                onClick={handleSubmit}
                disabled={fulfillRequest.isPending}
                className="w-full sm:w-auto"
              >
                {fulfillRequest.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <>
                    <Lock />
                    Save
                  </>
                )}
              </Button>
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                Saved in your account&apos;s secure vault. Never sent to the
                model provider.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Lock className="size-3.5" />
                <span>
                  Saved securely and never added to the task transcript.
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                An admin needs to provide these values before the task can
                continue.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
