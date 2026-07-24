'use client';

import type { ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button, ExternalLink, FileText, X } from '@/components/system';

import { getSetupDocsPath, getSetupDocsStep } from './setup-docs';
import { ArrowLeftToLine, ArrowRightToLine } from 'lucide-react';

export function SetupDocs({
  isOpen,
  onOpenChange,
  children,
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  children: ReactNode;
}) {
  const searchParams = useSearchParams();
  const docsPath = getSetupDocsPath(
    getSetupDocsStep(searchParams?.get('step') ?? null),
  );

  return (
    <>
      <div
        className={`fixed top-0 right-0 pr-2 pt-2 pb-3 z-40 hidden items-end min-[1050px]:flex flex-col h-full`}
      >
        {isOpen ? (
          <section className="h-full w-[min(30vw,30rem)] overflow-hidden rounded-r-2xl bg-card border-2 border-background border-l-4 border-l-card z-2">
            <div className="flex h-11 items-center justify-between pl-6 pr-3 bg-background">
              <span className="text-sm font-medium">Setup docs</span>
              <div className="flex items-center">
                <Button asChild variant="ghost" size="icon">
                  <a
                    href={`https://docs.roomote.dev/${docsPath}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Open this documentation page in a new tab"
                  >
                    <ExternalLink />
                  </a>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Close docs"
                  onClick={() => onOpenChange(false)}
                >
                  <ArrowRightToLine />
                </Button>
              </div>
            </div>
            <div className="docs-content h-[calc(100%-2.75rem)] overflow-y-auto px-5 py-6 scroll-minimal">
              {children}
            </div>
          </section>
        ) : null}
        <div className="mt-2 mr-2 absolute animate-[enter-down_0.5s_1_1000ms_backwards]">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(true)}
            className="rounded-full hover:bg-foreground hover:text-accent-bright-foreground"
          >
            <ArrowLeftToLine />
            Docs are here
          </Button>
        </div>
      </div>

      <div className={`block min-[1050px]:hidden right-2 bottom-2 absolute`}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onOpenChange(true)}
        >
          <FileText />
          Docs
        </Button>
      </div>
    </>
  );
}
