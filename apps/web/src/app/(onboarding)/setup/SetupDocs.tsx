'use client';

import type { ReactNode } from 'react';
import { Button, FileText, X } from '@/components/system';

export function SetupDocs({
  isOpen,
  onOpenChange,
  children,
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  children: ReactNode;
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
          <div className="docs-content h-[calc(100%-2.75rem)] overflow-y-auto px-5 py-6">
            {children}
          </div>
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
