export interface OpenCodeSession {
  id: string;
  title?: string;
  parentID?: string;
}

export interface OpenCodeMessageInfo {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  parentID?: string;
  modelID?: string;
  providerID?: string;
  /** Agent that produced the assistant message (`mode` in OpenCode's API). */
  mode?: string;
  /** Newer OpenCode releases surface the agent name as `agent`. */
  agent?: string;
  time?: {
    created?: number;
    completed?: number;
  };
  error?: unknown;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: {
      read?: number;
      write?: number;
    };
  };
  cost?: number;
  finish?: string;
}

export interface OpenCodeTextPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'text';
  text: string;
}

export interface OpenCodeReasoningPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'reasoning';
  text: string;
}

export interface OpenCodeToolPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'tool';
  tool: string;
  callID: string;
  metadata?: Record<string, unknown>;
  state?: {
    status?:
      | 'pending'
      | 'running'
      | 'completed'
      | 'error'
      | 'failed'
      | 'cancelled'
      | 'canceled';
    input?: Record<string, unknown>;
    output?: unknown;
    error?: unknown;
    title?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface OpenCodeSubtaskPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'subtask';
  prompt: string;
  description: string;
  agent: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  command?: string;
}

export type OpenCodePart =
  | OpenCodeTextPart
  | OpenCodeReasoningPart
  | OpenCodeToolPart
  | OpenCodeSubtaskPart
  | (Record<string, unknown> & {
      id?: string;
      sessionID?: string;
      messageID?: string;
      type?: string;
    });

export interface OpenCodeSessionMessage {
  info: OpenCodeMessageInfo;
  parts: OpenCodePart[];
}

export interface OpenCodePromptPart {
  type: 'text' | 'file';
  text?: string;
  mime?: string;
  filename?: string;
  url?: string;
}

export interface OpenCodePromptRequest {
  messageID?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  agent?: string;
  system?: string;
  parts: OpenCodePromptPart[];
}

export interface OpenCodeQuestionRequest {
  id: string;
  sessionID: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
  tool?: {
    messageID: string;
    callID: string;
  };
}

export interface OpenCodeGlobalEvent {
  directory?: string;
  payload?: OpenCodeEventPayload;
  type?: string;
  properties?: Record<string, unknown>;
}

export interface OpenCodeEventPayload {
  type: string;
  properties?: Record<string, unknown>;
}
