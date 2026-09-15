import type { ReactNode } from 'react';
import Image from 'next/image';

import {
  ChartColumnIncreasing,
  Github,
  House,
  Menu,
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
        className="pointer-events-none absolute inset-0 flex flex-col select-none bg-card opacity-75 blur-[4px] saturate-125"
        data-slot="pre-session-product-preview"
      >
        <div className="flex h-(--header-height) shrink-0 items-center gap-2 px-1 pr-2 md:hidden">
          <div className="flex size-9 items-center justify-center text-muted-foreground">
            <Menu className="size-5" />
          </div>
          <Image src="/logos/r.svg" alt="" width={28} height={28} />
          <div className="flex size-9 items-center justify-center text-muted-foreground">
            <Plus className="size-5" />
          </div>
          <div className="flex-1" />
          <div className="flex size-9 items-center justify-center text-muted-foreground">
            <Search className="size-5" />
          </div>
          <div className="flex size-9 items-center justify-center rounded-full bg-muted text-xs font-semibold">
            LA
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
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
            <div className="flex h-full min-h-0 w-full flex-1 flex-col overflow-clip rounded-3xl bg-background">
              <div className="flex min-h-0 flex-1 justify-center md:items-center">
                <div className="flex h-full w-full max-w-3xl flex-col px-4">
                  <div className="flex min-h-0 flex-1 flex-col justify-start gap-4 md:justify-center md:gap-3">
                    <h2 className="pt-10 text-2xl font-bold tracking-tight md:pt-0">
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

                    <div className="flex flex-col gap-2 text-sm md:flex-row md:items-center">
                      <div className="flex items-center gap-2">
                        <Github className="size-4 shrink-0" />
                        <span>Link your GitHub account</span>
                        <span className="ml-auto text-muted-foreground md:ml-0">
                          &times;
                        </span>
                      </div>
                      <span className="w-full rounded-full bg-foreground px-4 py-2 text-center font-semibold text-card md:w-auto">
                        Link
                      </span>
                      <span className="inline-flex items-center gap-1.5 font-semibold text-muted-foreground md:ml-auto">
                        <MessageCirclePlus className="size-4" />
                        Feedback, please!
                      </span>
                    </div>
                  </div>

                  <div className="mx-auto flex w-full shrink-0 overflow-hidden rounded-t-xl bg-card text-sm font-semibold text-muted-foreground">
                    <div className="border-r-2 border-background px-5 py-3">
                      Recent Sessions
                    </div>
                    <div className="px-5 py-3">Recent PRs</div>
                  </div>
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-0 bg-accent-bright-foreground/55" />
      <div className="relative z-base flex min-h-effective-viewport w-full items-center justify-center">
        {children}
      </div>
    </div>
  );
}
