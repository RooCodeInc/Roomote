'use client';

import { useQuery } from '@tanstack/react-query';
import { Streamdown } from 'streamdown';

import {
  Astroid,
  Button,
  ChevronDown,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
  SquareArrowOutUpRight,
} from '@/components/system';
import {
  DOCS_SELF_HOSTING_URL,
  GITHUB_RELEASES_BASE_URL,
} from '@/lib/release-links';
import { toReleaseTag } from '@/lib/product-version';
import { useTRPC } from '@/trpc/client';

type ReleaseNotesDialogMode = 'whats-new' | 'update-available';

type ReleaseNotesDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: ReleaseNotesDialogMode;
  version: string;
  runningVersion?: string | null;
};

function ReleaseNotesBody({
  version,
  summary,
  highlights,
  detailsMarkdown,
  isLoading,
  mode,
}: {
  version: string;
  summary: string | null;
  highlights: string[];
  detailsMarkdown: string;
  isLoading: boolean;
  mode: string;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Spinner className="size-5" />
      </div>
    );
  }

  const hasContent =
    Boolean(summary) || highlights.length > 0 || Boolean(detailsMarkdown);

  if (!hasContent) {
    return (
      <p className="text-sm text-muted-foreground">
        Release notes for {toReleaseTag(version)} are unavailable right now. You
        can view the details on Github.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {summary ? (
        <p className="text-sm text-foreground/90 whitespace-pre-wrap">
          {summary}
        </p>
      ) : null}

      {highlights.length > 0 ? (
        <div className="space-y-2">
          <h2 className="text-base font-semibold tracking-tight flex items-center gap-2">
            <Astroid className="size-4" />
            <span>Highlights for {version}</span>
          </h2>
          <div className="border-l-2 pl-4 ml-1.5">
            <ul className="space-y-1 text-sm">
              {highlights.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>

            {mode === 'update-available' ? (
              <p className="text-sm mt-3">
                For upgrade instructions, check our{' '}
                <a
                  href={DOCS_SELF_HOSTING_URL}
                  target="_blank"
                  className="underline"
                  rel="noreferrer"
                >
                  self-hosting docs.
                </a>
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {detailsMarkdown ? (
        <Collapsible defaultOpen={!summary && highlights.length === 0}>
          <CollapsibleTrigger className="text-sm cursor-pointer font-semibold text-foreground hover:underline group">
            Show all changes
            <ChevronDown className="inline size-4 group-data-[state=open]:rotate-180 transition-transform mr-1" />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <div className="dark:prose-invert">
              <Streamdown className="text-sm [&_[data-streamdown='heading-1']]:text-lg! [&_[data-streamdown='heading-2']]:text-base! [&_[data-streamdown='heading-3']]:text-base!">
                {detailsMarkdown}
              </Streamdown>
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

export function ReleaseNotesDialog({
  open,
  onOpenChange,
  mode,
  version,
  runningVersion,
}: ReleaseNotesDialogProps) {
  const trpc = useTRPC();
  const notesQuery = useQuery(
    trpc.releases.notes.queryOptions(
      { version },
      {
        enabled: open && Boolean(version),
        staleTime: 30 * 60 * 1000,
      },
    ),
  );

  const tag = toReleaseTag(version);
  const htmlUrl =
    notesQuery.data?.htmlUrl ?? `${GITHUB_RELEASES_BASE_URL}/tag/${tag}`;
  const title =
    mode === 'whats-new'
      ? `See what's new on Roomote`
      : `A new version of Roomote is available`;
  const description =
    mode === 'whats-new'
      ? 'Your deployment was just upgraded.'
      : runningVersion
        ? `You are on ${toReleaseTag(runningVersion)}. You may want to upgrade.`
        : 'A newer release is ready to install.';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto" size="3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <ReleaseNotesBody
          version={version}
          summary={notesQuery.data?.summary ?? null}
          highlights={notesQuery.data?.highlights ?? []}
          detailsMarkdown={notesQuery.data?.detailsMarkdown ?? ''}
          isLoading={notesQuery.isLoading}
          mode={mode}
        />

        <DialogFooter className="flex-col gap-2 md:flex-row md:justify-end">
          <a
            href="https://discord.gg/roomote"
            target="_blank"
            className="order-2 text-sm underline md:order-1 md:mr-auto"
            rel="noreferrer"
          >
            Join us on Discord
          </a>
          <div className="order-1 flex justify-end gap-2 md:order-2">
            <Button variant="outline" asChild>
              <a href={htmlUrl} target="_blank" rel="noreferrer">
                Go to the release
                <SquareArrowOutUpRight />
              </a>
            </Button>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
