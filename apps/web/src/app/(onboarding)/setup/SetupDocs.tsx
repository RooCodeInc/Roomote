'use client';

import { useState } from 'react';

import { Button, X } from '@/components/system';
import { DOCS_BASE_URL } from '@/lib/docs';

import type { SetupStep } from './types';

type SetupDocsStep = SetupStep | 'email-account' | 'email-password';

const SETUP_DOC_PATHS: Record<SetupDocsStep, string> = {
  welcome: '/',
  'email-account': '/self-hosting',
  'email-password': '/self-hosting',
  'auth-provider': '/communications',
  'auth-env-vars': '/communications',
  slack: '/providers/communications/slack',
  'env-vars': '/models',
  'source-control-provider': '/source-control',
  'source-control-config': '/source-control',
  'source-control-connect': '/source-control',
  'qualification-blocked': '/self-hosting',
  'compute-provider': '/compute',
  'compute-config': '/compute',
  'repo-selection': '/environments',
  invoke: '/how-roomote-works',
};

export function getSetupDocsStep(step: string | null): SetupDocsStep {
  return step && step in SETUP_DOC_PATHS ? (step as SetupDocsStep) : 'welcome';
}

export function getSetupDocsUrl(step: SetupDocsStep): string {
  return `${DOCS_BASE_URL}${SETUP_DOC_PATHS[step]}`;
}

export function SetupDocs({ step }: { step: SetupDocsStep }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="fixed top-9 right-9 z-40 hidden items-end gap-3 md:flex md:flex-col">
      {isOpen ? (
        <section className="h-[calc(100vh-6.5rem)] w-[min(42vw,42rem)] overflow-hidden rounded-xl border border-border bg-background shadow-xl">
          <div className="flex h-11 items-center justify-between border-b px-3">
            <span className="text-sm font-medium">Setup docs</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close docs"
              onClick={() => setIsOpen(false)}
            >
              <X />
            </Button>
          </div>
          <iframe
            key={step}
            src={getSetupDocsUrl(step)}
            title="Roomote setup documentation"
            className="h-[calc(100%-2.75rem)] w-full border-0"
          />
        </section>
      ) : null}
      <Button type="button" onClick={() => setIsOpen(true)}>
        Show docs
      </Button>
    </div>
  );
}
