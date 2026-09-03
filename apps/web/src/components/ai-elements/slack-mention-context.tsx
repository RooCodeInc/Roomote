'use client';

import { createContext, useContext, type ReactNode } from 'react';

interface SlackMentionContextValue {
  /** Slack team the surrounding transcript came from, when known. */
  slackTeamId: string | null;
}

const DEFAULT_SLACK_MENTION_CONTEXT: SlackMentionContextValue = {
  slackTeamId: null,
};

const SlackMentionContext = createContext<SlackMentionContextValue>(
  DEFAULT_SLACK_MENTION_CONTEXT,
);

/**
 * Tells transcript messages which Slack workspace their raw `<@U…>` mention
 * tokens belong to so they can be resolved to names and profile links.
 */
export function SlackMentionProvider({
  children,
  slackTeamId,
}: {
  children: ReactNode;
  slackTeamId: string | null | undefined;
}) {
  return (
    <SlackMentionContext.Provider value={{ slackTeamId: slackTeamId ?? null }}>
      {children}
    </SlackMentionContext.Provider>
  );
}

export function useSlackMentionContext() {
  return useContext(SlackMentionContext);
}
