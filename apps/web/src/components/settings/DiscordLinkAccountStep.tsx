'use client';

import { useEffect, useRef, useState } from 'react';

import {
  Button,
  Check,
  CopyIconButton,
  ExternalLink,
  LucideLink,
} from '@/components/system';
import {
  useCreateDiscordLinkCode,
  useDiscordLinkedAccount,
} from '@/hooks/linked-accounts';

export function DiscordLinkAccountStep({
  pollUntilLinked = false,
  autoGenerate = false,
}: {
  pollUntilLinked?: boolean;
  autoGenerate?: boolean;
} = {}) {
  const discordAccount = useDiscordLinkedAccount({
    refetchInterval: pollUntilLinked ? 2_000 : false,
  });
  const createLinkCode = useCreateDiscordLinkCode();
  const [link, setLink] = useState<{
    code: string;
    command: string;
    expiresInSeconds: number;
    openDiscordUrl: string;
  } | null>(null);
  const autoGenerateStarted = useRef(false);

  useEffect(() => {
    if (
      !autoGenerate ||
      autoGenerateStarted.current ||
      discordAccount.data?.mapping ||
      discordAccount.data?.configured !== true
    ) {
      return;
    }
    autoGenerateStarted.current = true;
    createLinkCode.mutate(undefined, { onSuccess: setLink });
  }, [autoGenerate, createLinkCode, discordAccount.data]);

  if (!discordAccount.data?.configured) return null;

  const mapping = discordAccount.data.mapping;
  if (mapping) {
    const displayName =
      mapping.discordGlobalName ??
      (mapping.discordUsername ? `@${mapping.discordUsername}` : null) ??
      mapping.discordUserId;
    return (
      <div className="flex items-start gap-2 mt-4">
        <Check className="inline size-4 mt-0.5 shrink-0 text-green-600" />
        <p className="text-sm">
          Your Discord account (
          <span className="ph-no-capture">{displayName}</span>) is linked —
          tasks you start from Discord are attributed to you.
        </p>
      </div>
    );
  }

  const generate = () =>
    createLinkCode.mutate(undefined, { onSuccess: setLink });

  return (
    <div className="space-y-3 mt-4 max-w-sm">
      {link ? (
        <>
          <p className="text-sm">
            Within {Math.round(link.expiresInSeconds / 60)} minutes, run this
            command in a server with Roomote or in a DM with the bot:
          </p>
          <div className="flex h-10 w-full items-center gap-2 rounded-md border border-black px-3">
            <code className="min-w-0 grow truncate font-mono text-sm select-all ph-no-capture">
              {link.command}
            </code>
            <CopyIconButton
              aria-label="Copy Discord link command"
              content={link.command}
              tooltip="Copy link command"
              className="shrink-0"
            />
          </div>
          <Button asChild className="w-full">
            <a
              href={link.openDiscordUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink />
              Open Discord
            </a>
          </Button>
        </>
      ) : createLinkCode.isPending ? (
        <p className="text-sm">Generating your Discord link…</p>
      ) : (
        <>
          <p className="text-sm">
            Link your Discord account so work you start there is attributed to
            you.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={generate}>
            <LucideLink />
            Link your Discord account
          </Button>
        </>
      )}
    </div>
  );
}
