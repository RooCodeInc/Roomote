'use client';

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

const SetupDocsContext = createContext<(content: ReactNode) => void>(() => {});

export function SetupDocsContentProvider({
  children,
  setContent,
}: {
  children: ReactNode;
  setContent: (content: ReactNode) => void;
}) {
  return (
    <SetupDocsContext.Provider value={setContent}>
      {children}
    </SetupDocsContext.Provider>
  );
}

export function useSetSetupDocsContent() {
  return useContext(SetupDocsContext);
}
