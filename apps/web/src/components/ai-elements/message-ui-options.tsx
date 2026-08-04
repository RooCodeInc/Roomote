'use client';

import { createContext, useContext, type ReactNode } from 'react';

export interface MessageUiOptions {
  compact?: boolean;
  displayMode?: 'default' | 'narration';
  expandReasoningByDefault?: boolean;
  hideNewTaskAction?: boolean;
}

const DEFAULT_MESSAGE_UI_OPTIONS: MessageUiOptions = {};

const MessageUiOptionsContext = createContext<MessageUiOptions>(
  DEFAULT_MESSAGE_UI_OPTIONS,
);

export function MessageUiOptionsProvider({
  children,
  value,
}: {
  children: ReactNode;
  value?: MessageUiOptions;
}) {
  return (
    <MessageUiOptionsContext.Provider
      value={value ?? DEFAULT_MESSAGE_UI_OPTIONS}
    >
      {children}
    </MessageUiOptionsContext.Provider>
  );
}

export function useMessageUiOptions() {
  return useContext(MessageUiOptionsContext);
}
