import type {
  AcpMessageKind,
  AcpPlanPayload,
  AcpToolCallPayload,
  AcpToolResultPayload,
  AcpEventType,
  DataVisualizationBlock,
  SetupReceiptPayload,
  TaskMessageRole,
} from '@roomote/types';

/** Artifact backing an inline transcript image, when the server knows it. */
export interface AcpUiMessageImageArtifact {
  url: string;
  owner: { taskId: string } | { sessionId: string };
  path: string;
  version: number;
}

interface AcpUiMessageBase {
  id: string;
  ts: number;
  role: Exclude<TaskMessageRole, null>;
  partial: boolean;
  isTurnCompletion?: boolean;
  visibleInTranscript?: boolean;
  optimistic?: boolean;
  clientMessageId?: string;
  logicalEventId?: string;
  sessionId: string | null;
  updateType: AcpEventType;
  text?: string;
  images?: string[];
  imageArtifacts?: AcpUiMessageImageArtifact[];
  charts?: DataVisualizationBlock[];
  toolCallId?: string;
  previousTs?: number;
  userId?: string;
  userName?: string | null;
  userEmail?: string | null;
  userImageUrl?: string | null;
}

export interface AcpToolCallUiMessage extends AcpUiMessageBase {
  kind: 'tool_call';
  data: AcpToolCallPayload;
}

export interface AcpToolResultUiMessage extends AcpUiMessageBase {
  kind: 'tool_result';
  data: AcpToolResultPayload;
}

export interface AcpSetupReceiptUiMessage extends AcpUiMessageBase {
  kind: 'setup_receipt';
  data: SetupReceiptPayload;
}

export interface AcpPlanUiMessage extends AcpUiMessageBase {
  kind: 'plan';
  data: AcpPlanPayload;
}

export interface AcpTodoSectionUiMessage extends AcpUiMessageBase {
  kind: 'todo_section';
  data: {
    todoId: string;
    content: string;
  };
}

export interface AcpOtherUiMessage extends AcpUiMessageBase {
  kind: Exclude<
    AcpMessageKind,
    'tool_call' | 'tool_result' | 'plan' | 'setup_receipt'
  >;
  data: Record<string, unknown>;
  /** Source chunks before reasoning-only display normalization. */
  rawText?: string;
}

export type AcpUiMessage =
  | AcpToolCallUiMessage
  | AcpToolResultUiMessage
  | AcpSetupReceiptUiMessage
  | AcpPlanUiMessage
  | AcpTodoSectionUiMessage
  | AcpOtherUiMessage;
