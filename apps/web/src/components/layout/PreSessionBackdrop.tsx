import type { ReactNode } from 'react';
import Image from 'next/image';

import {
  ChartColumnIncreasing,
  House,
  MessageCirclePlus,
  Mic,
  NotepadText,
  PanelLeftOpen,
  Plus,
  Search,
  SendHorizontal,
  Settings,
  Zap,
} from '@/components/system';

const PREVIEW_NAV_ITEMS = [
  Plus,
  House,
  NotepadText,
  Zap,
  ChartColumnIncreasing,
  Settings,
  Search,
  PanelLeftOpen,
] as const;

export function PreSessionBackdrop({ children }: { children: ReactNode }) {
  return (
    <div className="light relative min-h-effective-viewport w-full overflow-hidden bg-accent-bright-foreground text-foreground">
      <div
        aria-hidden="true"
        inert
        className="pointer-events-none absolute -inset-6 flex select-none bg-card opacity-75 blur-[4px] saturate-125"
        data-slot="pre-session-product-preview"
      >
        <aside className="hidden w-16 shrink-0 flex-col items-center gap-2 bg-card px-3 py-5 md:flex">
          <Image
            src="/logos/r.svg"
            alt=""
            width={28}
            height={28}
            className="mb-3 size-7"
          />
          {PREVIEW_NAV_ITEMS.map((Icon, index) => (
            <div
              key={index}
              className={
                index === 1
                  ? 'flex size-10 items-center justify-center rounded-full bg-foreground text-accent-foreground'
                  : 'flex size-10 items-center justify-center text-muted-foreground'
              }
            >
              <Icon className="size-5" />
            </div>
          ))}
          <div className="mt-auto flex size-9 items-center justify-center rounded-full bg-muted text-xs font-semibold">
            LA
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 p-2">
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl bg-background">
            <div className="flex h-14 items-center justify-between bg-card px-4 md:hidden">
              <Image src="/logos/r.svg" alt="" width={28} height={28} />
              <div className="flex size-9 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                LA
              </div>
            </div>

            <div className="flex min-h-0 flex-1 items-center justify-center px-4 pb-16">
              <div className="flex w-full max-w-3xl flex-col gap-3">
                <h2 className="text-2xl font-bold tracking-tight">
                  Let&apos;s cook!
                </h2>

                <div className="flex min-h-44 flex-col rounded-lg border-2 border-accent-foreground bg-card p-3">
                  <p className="text-sm text-muted-foreground">
                    Review this pull request and address the feedback
                  </p>
                  <div className="mt-auto flex items-center gap-2">
                    <div className="flex size-8 items-center justify-center rounded-md">
                      <Plus className="size-4" />
                    </div>
                    <div className="rounded-md px-2 py-1 text-xs text-muted-foreground">
                      GPT 5.6 Terra Low
                    </div>
                    <Mic className="ml-auto size-4 text-muted-foreground" />
                    <div className="flex size-8 items-center justify-center rounded-full bg-foreground text-card">
                      <SendHorizontal className="size-4" />
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>Link your GitHub account</span>
                  <span className="rounded-full bg-foreground px-4 py-2 font-semibold text-card">
                    Link
                  </span>
                  <span className="text-muted-foreground">&times;</span>
                  <span className="ml-auto inline-flex items-center gap-1.5 font-semibold text-muted-foreground">
                    <MessageCirclePlus className="size-4" />
                    Feedback, please!
                  </span>
                </div>
              </div>
            </div>

            <div className="absolute bottom-0 left-1/2 flex w-[min(48rem,calc(100%-2rem))] -translate-x-1/2 overflow-hidden rounded-t-xl bg-card text-sm font-semibold text-muted-foreground">
              <div className="border-r-2 border-background px-5 py-3">
                Recent Sessions
              </div>
              <div className="px-5 py-3">Recent PRs</div>
            </div>
          </div>
        </main>
      </div>

      <div className="pointer-events-none absolute inset-0 bg-accent-bright-foreground/55" />
      <div className="relative z-base flex min-h-effective-viewport w-full items-center justify-center">
        {children}
      </div>
    </div>
  );
}
