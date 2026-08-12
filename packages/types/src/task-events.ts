export const TaskEventName = {
  TaskStarted: 'taskStarted',
  TaskCompleted: 'taskCompleted',
  TaskAborted: 'taskAborted',
  Message: 'message',
} as const;

export type TaskEventName = (typeof TaskEventName)[keyof typeof TaskEventName];

export interface TaskMessage {
  ts: number;
  type: 'ask' | 'say';
  ask?: string;
  say?: string;
  text?: string;
  images?: string[];
  partial?: boolean;
  reasoning?: string;
  command?: string | null;
  exitCode?: number | null;
}

export interface TaskMessageEnvelope {
  taskId: string;
  action: 'created' | 'updated';
  message: TaskMessage;
}

export interface TaskTokenUsage {
  totalTokensIn: number;
  totalTokensOut: number;
  totalCacheWrites?: number;
  totalCacheReads?: number;
  totalCost: number;
  contextTokens: number;
}

export interface TaskToolUsageEntry {
  attempts: number;
  failures: number;
}

export type TaskToolUsage = Record<string, TaskToolUsageEntry>;

export interface TaskCompletionMetadata {
  isSubtask: boolean;
  completionId?: string;
}

export type TaskEventStartedPayload = [taskId: string];
export type TaskEventCompletedPayload = [
  taskId: string,
  tokenUsage: TaskTokenUsage,
  toolUsage: TaskToolUsage,
  metadata: TaskCompletionMetadata,
];
export type TaskEventAbortedPayload = [taskId: string];
export type TaskEventMessagePayload = [message: TaskMessageEnvelope];

export type TaskEvent =
  | {
      eventName: typeof TaskEventName.TaskStarted;
      payload: TaskEventStartedPayload;
    }
  | {
      eventName: typeof TaskEventName.TaskCompleted;
      payload: TaskEventCompletedPayload;
    }
  | {
      eventName: typeof TaskEventName.TaskAborted;
      payload: TaskEventAbortedPayload;
    }
  | {
      eventName: typeof TaskEventName.Message;
      payload: TaskEventMessagePayload;
    }
  | {
      eventName: TaskEventName | string;
      payload: unknown[];
    };
