'use client';

import { type MutableRefObject, useEffect } from 'react';
import { useStickToBottomContext } from 'use-stick-to-bottom';

import type { MessagesHandle } from './Messages';

/**
 * Bridges the StickToBottom context to an imperative ref so parent
 * components outside the Conversation tree can trigger a scroll.
 */
export function ScrollBridge({
  handleRef,
}: {
  handleRef: MutableRefObject<MessagesHandle | null>;
}) {
  const { scrollToBottom } = useStickToBottomContext();

  useEffect(() => {
    handleRef.current = { scrollToBottom };
  }, [handleRef, scrollToBottom]);

  return null;
}
