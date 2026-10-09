'use client';

import { useState } from 'react';

/** Pin the control for a nonempty draft once a peer was present. */
export function usePeopleSendAvailable(shared: boolean, draft: string) {
  const [pinned, setPinned] = useState(false);
  const nextPinned = draft.length > 0 && (shared || pinned);
  if (nextPinned !== pinned) setPinned(nextPinned);
  return shared || nextPinned;
}
