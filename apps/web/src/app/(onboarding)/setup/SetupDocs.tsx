'use client';

import { Button, FileText, X } from '@/components/system';
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

export function SetupDocs({
  step,
  isOpen,
  onOpenChange,
}: {
  step: SetupDocsStep;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}) {
  return (
    <div className="fixed top-0 right-0 pr-2 pt-[8px] pb-[12px] z-40 hidden items-end min-[1050px]:flex flex-col h-full">
      {isOpen ? (
        <section className="h-full w-[min(30vw,30rem)] overflow-hidden rounded-r-2xl bg-card border-2 border-background border-l-4 border-l-card z-2">
          <div className="flex h-11 items-center justify-between px-3 bg-background">
            <span className="text-sm font-medium">Setup docs</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close docs"
              onClick={() => onOpenChange(false)}
            >
              <X />
            </Button>
          </div>
          <iframe
            key={step}
            src={getSetupDocsUrl(step)}
            title="Roomote setup documentation"
            className="h-[calc(100%-2.75rem)] w-full border-0 bg-background"
          />
        </section>
      ) : null}
      <div className="mt-4 mr-4 absolute">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onOpenChange(true)}
        >
          <FileText />
          Docs
        </Button>
      </div>
    </div>
  );
}
