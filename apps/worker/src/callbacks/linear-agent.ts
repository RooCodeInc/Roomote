import {
  getTaskReportConsumerFromPayload,
  type TaskPayload,
  TaskPayloadKind,
} from '@roomote/types';
import type {
  AgentSessionPlanStep,
  AgentSessionPlanStepStatus,
} from '@roomote/linear/client';
import { type TaskRun, sdk } from '@roomote/sdk/client';

import type {
  CallbackEvent,
  RunTaskCallbacks,
  RunTaskContext,
} from '../run-task';
import { captureWorkerException } from '../monitoring/sentry';

import {
  getLinearFastParentSessionId,
  getLinearSessionIdFromResumePayload,
} from '../run-task/linear-resume-payload';

import { getCallbackEventKey } from './utils';
import {
  buildRequestUserInputTaskUrl,
  formatRequestUserInputPrompt,
  getRequestUserInputPromptSignature,
  isOpenCodeQuestionPlaceholderRequest,
  isSingleQuestionRequestUserInput,
  supportsIntegrationRequestUserInput,
} from './request-user-input';

function reportLinearCallbackError(
  error: unknown,
  stage: string,
  runId: number,
): void {
  captureWorkerException(error, {
    runId,
    stage,
  });
}

function getRequestUserInputPromptSignatures(
  context: RunTaskContext,
): Map<string, string> {
  const existing = context.postedRequestUserInputSignatures;

  if (existing instanceof Map) {
    return existing as Map<string, string>;
  }

  const next = new Map<string, string>();
  context.postedRequestUserInputSignatures = next;
  return next;
}

/**
 * Represents a todo item from the todo_update callback event.
 */
interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * Convert todo items to Linear's AgentSessionPlanStep format.
 *
 * Maps todo items to plan steps with appropriate statuses:
 * - Completed todos → 'completed'
 * - In-progress todos → 'inProgress'
 * - If no in-progress item, first uncompleted todo → 'inProgress'
 * - Remaining uncompleted todos → 'pending'
 */
function convertTodosToAgentPlan(todos: TodoItem[]): AgentSessionPlanStep[] {
  // Check if any item is explicitly marked as in progress
  const hasExplicitInProgress = todos.some(
    (todo) => todo.status === 'in_progress',
  );

  const result = todos.reduce<{
    steps: AgentSessionPlanStep[];
    foundInProgress: boolean;
  }>(
    (acc, todo) => {
      let status: AgentSessionPlanStepStatus;

      if (todo.status === 'completed') {
        status = 'completed';
      } else if (todo.status === 'in_progress') {
        status = 'inProgress';
      } else if (!acc.foundInProgress) {
        // First uncompleted item is in progress
        status = 'inProgress';
        acc.foundInProgress = true;
      } else {
        status = 'pending';
      }

      acc.steps.push({
        content: todo.content,
        status,
      });

      return acc;
    },
    { steps: [], foundInProgress: hasExplicitInProgress },
  );

  return result.steps;
}

function getLinearSessionId(taskRun: TaskRun): string {
  // For LinearAgentSession jobs, sessionId is in the payload
  if (taskRun.payloadKind === TaskPayloadKind.LinearAgentSession) {
    const { sessionId } = taskRun.payload as TaskPayload<
      typeof TaskPayloadKind.LinearAgentSession
    >;

    if (!sessionId) {
      throw new Error('Session ID not found in payload.');
    }

    return sessionId;
  }

  // A task delegated from a Linear Fast Session carries the agent session as
  // its parent conversation.
  const parentSessionId = getLinearFastParentSessionId(taskRun.payload);
  if (parentSessionId) {
    return parentSessionId;
  }

  // For SnapshotResume runs with Linear metadata, the session id rides along
  // with the queued Linear follow-up messages in the payload.
  const resumeSessionId = getLinearSessionIdFromResumePayload(taskRun.payload);

  if (resumeSessionId) {
    return resumeSessionId;
  }

  throw new Error('Task run has no Linear session ID');
}

/**
 * Live activity for a task a Linear Fast Session delegated: thoughts,
 * actions, plan updates, and questions stream into the agent session the
 * way a direct Linear task's do. The final response stays with the Session,
 * which reports the settled outcome itself.
 */
export function getLinearSessionActivityStreamCallbacks(
  taskRun: TaskRun,
): RunTaskCallbacks {
  if (
    taskRun.payloadKind === TaskPayloadKind.LinearAgentSession ||
    !getLinearFastParentSessionId(taskRun.payload)
  ) {
    return {};
  }
  return linearAgentCallbacks;
}

export const linearAgentCallbacks: RunTaskCallbacks = {
  onStart: async (
    taskRun: TaskRun,
    taskId: string,
    context: RunTaskContext,
  ) => {
    if (context.sessionId) {
      return;
    }

    context.sessionId = taskId;
  },
  onMessage: async (
    taskRun: TaskRun,
    _taskId: string,
    event: CallbackEvent,
    context: RunTaskContext,
  ) => {
    if (event.type === 'turn_started') {
      return;
    }

    // Skip older events, but allow distinct same-timestamp events.
    // One Roomote message can map to multiple CallbackEvents with the same `ts`
    // (for example `tool_action` + `todo_update`).
    const lastProcessedTs = (context.lastProcessedTs as number) || 0;

    if (event.ts < lastProcessedTs) {
      return;
    }

    const processedEventKeys =
      (context.processedEventKeys as Set<string>) ?? new Set<string>();

    context.processedEventKeys = processedEventKeys;

    if (event.ts > lastProcessedTs) {
      context.lastProcessedTs = event.ts;
      processedEventKeys.clear();
    }

    const eventKey = getCallbackEventKey(event);

    if (processedEventKeys.has(eventKey)) {
      return;
    }

    processedEventKeys.add(eventKey);
    const sessionId = getLinearSessionId(taskRun);

    if (event.type === 'reasoning') {
      try {
        await sdk.linearSessions.emitThought(sessionId, event.text, true);
      } catch (error) {
        reportLinearCallbackError(
          error,
          'linearAgentCallbacks.onMessage.emitReasoning',
          taskRun.id,
        );
        console.error(
          `[linearAgentCallbacks#onMessage] Failed to emit reasoning: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (event.type === 'text') {
      try {
        await sdk.linearSessions.emitThought(sessionId, event.text);
      } catch (error) {
        reportLinearCallbackError(
          error,
          'linearAgentCallbacks.onMessage.emitText',
          taskRun.id,
        );
        console.error(
          `[linearAgentCallbacks#onMessage] Failed to emit text: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (event.type === 'completion') {
      try {
        // A delegated child's outcome is reported by its Fast Session; a
        // second response here would duplicate it.
        if (
          getTaskReportConsumerFromPayload(taskRun.payload) !== 'orchestrator'
        ) {
          await sdk.linearSessions.emitResponse(sessionId, event.text);
        }
        context.isCompleted = true;
      } catch (error) {
        reportLinearCallbackError(
          error,
          'linearAgentCallbacks.onMessage.emitResponse',
          taskRun.id,
        );
        console.error(
          `[linearAgentCallbacks#onMessage] Failed to emit response: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (event.type === 'followup') {
      try {
        if (event.suggestions.length > 0) {
          const options = event.suggestions.map(
            (s: string | { answer: string }) => ({
              value: typeof s === 'string' ? s : s.answer,
            }),
          );

          await sdk.linearSessions.emitElicitation(sessionId, event.question, {
            signal: 'select',
            signalMetadata: { options },
          });
        } else {
          await sdk.linearSessions.emitElicitation(sessionId, event.question);
        }
      } catch (error) {
        reportLinearCallbackError(
          error,
          'linearAgentCallbacks.onMessage.emitFollowup',
          taskRun.id,
        );
        console.error(
          `[linearAgentCallbacks#onMessage] Failed to emit followup: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (event.type === 'request_user_input') {
      const postedSignatures = getRequestUserInputPromptSignatures(context);
      const promptSignature = getRequestUserInputPromptSignature(event.request);

      if (postedSignatures.get(event.request.requestId) === promptSignature) {
        return;
      }

      // OpenCode streams the question tool before options land. Skip the empty
      // shell so Linear only shows the real structured elicitation.
      if (isOpenCodeQuestionPlaceholderRequest(event.request)) {
        return;
      }

      try {
        if (!supportsIntegrationRequestUserInput(event.request)) {
          const taskUrl = buildRequestUserInputTaskUrl(taskRun, 'linear');

          await sdk.linearSessions.emitElicitation(
            sessionId,
            `I need a private answer before I can continue. Please answer on the web UI: ${taskUrl}`,
          );
          postedSignatures.set(event.request.requestId, promptSignature);
          return;
        }

        await sdk.taskRuns.setPendingLinearRequestUserInput({
          runId: taskRun.id,
          sessionId,
          requestId: event.request.requestId,
          taskId: taskRun.taskId,
          questions: event.request.questions,
        });

        if (isSingleQuestionRequestUserInput(event.request)) {
          const question = event.request.questions[0]!;
          const options = question.options?.map((option) => ({
            value: option.label,
          }));

          await sdk.linearSessions.emitElicitation(
            sessionId,
            formatRequestUserInputPrompt(event.request),
            options && options.length > 0
              ? { signal: 'select', signalMetadata: { options } }
              : undefined,
          );
        } else {
          await sdk.linearSessions.emitElicitation(
            sessionId,
            formatRequestUserInputPrompt(event.request),
          );
        }

        postedSignatures.set(event.request.requestId, promptSignature);
      } catch (error) {
        reportLinearCallbackError(
          error,
          'linearAgentCallbacks.onMessage.emitRequestUserInput',
          taskRun.id,
        );
        console.error(
          `[linearAgentCallbacks#onMessage] Failed to emit request_user_input: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (event.type === 'request_user_input_response') {
      try {
        await sdk.taskRuns.clearPendingLinearRequestUserInput({
          runId: taskRun.id,
          sessionId,
          requestId: event.response.requestId,
        });
      } catch (error) {
        reportLinearCallbackError(
          error,
          'linearAgentCallbacks.onMessage.clearPendingRequestUserInput',
          taskRun.id,
        );
        console.error(
          `[linearAgentCallbacks#onMessage] Failed to clear request_user_input state: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (event.type === 'tool_action') {
      try {
        await sdk.linearSessions.emitAction(
          sessionId,
          event.usage.action,
          event.usage.details || 'file',
        );
      } catch (error) {
        reportLinearCallbackError(
          error,
          'linearAgentCallbacks.onMessage.emitToolAction',
          taskRun.id,
        );
        console.error(
          `[linearAgentCallbacks#onMessage] Failed to emit tool action: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (event.type === 'todo_update') {
      try {
        const plan = convertTodosToAgentPlan(event.todos);
        await sdk.linearSessions.updateSessionPlan(sessionId, plan);
      } catch (error) {
        reportLinearCallbackError(
          error,
          'linearAgentCallbacks.onMessage.updateTodoList',
          taskRun.id,
        );
        console.error(
          `[linearAgentCallbacks#onMessage] Failed to update TODO list: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (event.type === 'mcp_action') {
      try {
        await sdk.linearSessions.emitAction(
          sessionId,
          event.usage.action,
          event.usage.details || 'MCP tool',
        );
      } catch (error) {
        reportLinearCallbackError(
          error,
          'linearAgentCallbacks.onMessage.emitMcpAction',
          taskRun.id,
        );
        console.error(
          `[linearAgentCallbacks#onMessage] Failed to emit MCP action: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  },
  onExit: async (taskRun: TaskRun) => {
    try {
      await sdk.taskRuns.clearPendingLinearRequestUserInput({
        runId: taskRun.id,
        sessionId: getLinearSessionId(taskRun),
      });
    } catch (error) {
      reportLinearCallbackError(
        error,
        'linearAgentCallbacks.onExit.clearPendingRequestUserInput',
        taskRun.id,
      );
      console.error(
        `[linearAgentCallbacks#onExit] Failed to clear pending request_user_input state: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  },
};
