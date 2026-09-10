'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * Transcript a Slack mention belongs to. The server derives the Slack team
 * from this resource; the browser never names a workspace directly.
 */
export type SlackMentionScope =
  | { kind: 'task'; taskId: string }
  | { kind: 'session'; sessionId: string };

interface SlackMentionContextValue {
  scope: SlackMentionScope | null;
}

const DEFAULT_SLACK_MENTION_CONTEXT: SlackMentionContextValue = {
  scope: null,
};

const SlackMentionContext = createContext<SlackMentionContextValue>(
  DEFAULT_SLACK_MENTION_CONTEXT,
);

/**
 * Tells transcript messages which task or session their raw `<@U…>` mention
 * tokens belong to so they can be resolved to names and profile links.
 */
export function SlackMentionProvider({
  children,
  scope,
}: {
  children: ReactNode;
  scope: SlackMentionScope | null | undefined;
}) {
  return (
    <SlackMentionContext.Provider value={{ scope: scope ?? null }}>
      {children}
    </SlackMentionContext.Provider>
  );
}

export function useSlackMentionContext() {
  return useContext(SlackMentionContext);
}
