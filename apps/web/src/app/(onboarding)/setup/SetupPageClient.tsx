'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';

import { useUser } from '@/hooks/useUser';

import { useSetSetupDocsContent } from './SetupDocsContext';
import { SetupBootstrapFlow } from './SetupBootstrapFlow';
import { SetupSignedInFlow } from './SetupSignedInFlow';

export default function SetupPageClient({
  setupDocsContent,
}: {
  setupDocsContent: ReactNode;
}) {
  const setSetupDocsContent = useSetSetupDocsContent();

  useEffect(() => {
    setSetupDocsContent(setupDocsContent);
  }, [setSetupDocsContent, setupDocsContent]);

  return <SetupPageContent />;
}

function SetupPageContent() {
  const { isSignedIn } = useUser();

  // Each flow owns its own lifecycle so bootstrap-only state never leaks into
  // the signed-in setup wizard.
  return isSignedIn ? <SetupSignedInFlow /> : <SetupBootstrapFlow />;
}
