'use client';

import { useQuery } from '@tanstack/react-query';
import { Streamdown } from 'streamdown';

import {
  Button,
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
}: {
  version: string;
  summary: string | null;
  highlights: string[];
  detailsMarkdown: string;
  isLoading: boolean;
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
          <h3 className="text-sm font-semibold">Highlights</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-foreground/90">
            {highlights.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {detailsMarkdown ? (
        <Collapsible defaultOpen={!summary && highlights.length === 0}>
          <CollapsibleTrigger className="text-sm font-semibold text-foreground hover:underline">
            All changes
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <div className="prose prose-sm dark:prose-invert max-w-none text-foreground/90">
              <Streamdown>{detailsMarkdown}</Streamdown>
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
      ? `What's new in Roomote ${tag}`
      : `Roomote ${tag} is available`;
  const description =
    mode === 'whats-new'
      ? 'Highlights from the release now running in this deployment.'
      : runningVersion
        ? `You are on ${toReleaseTag(runningVersion)}. You may want to upgrade.`
        : 'A newer release is ready to install.';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto" size="2xl">
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
        />

        {mode === 'update-available' ? (
          <p className="text-sm">
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

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <a href={htmlUrl} target="_blank" rel="noreferrer">
                View details
                <SquareArrowOutUpRight />
              </a>
            </Button>
          </div>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {mode === 'whats-new' ? 'Got it' : 'Upgrade later'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
