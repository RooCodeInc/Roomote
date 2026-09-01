'use client';

import { useSyncExternalStore } from 'react';

type ModelSwitcherOpener = () => void;

let opener: ModelSwitcherOpener | null = null;
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

export function registerProviderRetryModelSwitcher(
  nextOpener: ModelSwitcherOpener,
): () => void {
  opener = nextOpener;
  emitChange();

  return () => {
    if (opener !== nextOpener) {
      return;
    }

    opener = null;
    emitChange();
  };
}

export function useProviderRetryModelSwitcher(): ModelSwitcherOpener | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => opener,
    () => null,
  );
}
