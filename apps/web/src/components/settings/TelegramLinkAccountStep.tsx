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
  useCreateTelegramLinkCode,
  useTelegramLinkedAccount,
} from '@/hooks/linked-accounts';

/**
 * Final step of the Telegram comms setup: link the admin's own Telegram
 * account. The deep link opens the bot with `/start <code>`, so one tap
 * covers first contact, primary-chat capture, and account linking.
 */
export function TelegramLinkAccountStep({
  pollUntilLinked = false,
  autoGenerate = false,
}: {
  pollUntilLinked?: boolean;
  autoGenerate?: boolean;
} = {}) {
  const telegramAccount = useTelegramLinkedAccount({
    refetchInterval: pollUntilLinked ? 2_000 : false,
  });
  const createTelegramLinkCode = useCreateTelegramLinkCode();
  const [linkCode, setLinkCode] = useState<{
    code: string;
    expiresInSeconds: number;
    deepLink: string | null;
  } | null>(null);
  const autoGenerateStarted = useRef(false);

  useEffect(() => {
    if (
      !autoGenerate ||
      autoGenerateStarted.current ||
      telegramAccount.data?.mapping ||
      telegramAccount.data?.configured !== true
    ) {
      return;
    }

    autoGenerateStarted.current = true;
    createTelegramLinkCode.mutate(undefined, {
      onSuccess: (result) => setLinkCode(result),
    });
  }, [autoGenerate, createTelegramLinkCode, telegramAccount.data]);

  if (!telegramAccount.data?.configured) {
    return null;
  }

  const mapping = telegramAccount.data.mapping;

  if (mapping) {
    return (
      <div className="flex items-start gap-2 mt-4">
        <Check className="inline size-4 mt-0.5 shrink-0 text-green-600" />
        <p className="text-sm">
          Your Telegram account (
          {mapping.telegramUsername
            ? `@${mapping.telegramUsername}`
            : mapping.telegramUserId}
          ) is linked — tasks you start from Telegram are attributed to you.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 mt-4">
      {linkCode ? (
        <div className="max-w-sm space-y-3">
          <p className="text-sm">
            Send this code to the bot within{' '}
            {Math.round(linkCode.expiresInSeconds / 60)} minutes to link your
            Telegram account:
          </p>
          <div className="flex h-10 w-full items-center gap-2 rounded-md border border-black px-3">
            <code className="min-w-0 grow truncate font-mono text-sm select-all ph-no-capture">
              {linkCode.code}
            </code>
            <CopyIconButton
              aria-label="Copy Telegram link code"
              content={linkCode.code}
              tooltip="Copy link code"
              className="shrink-0"
            />
          </div>
          {linkCode.deepLink && (
            <Button asChild className="w-full">
              <a
                href={linkCode.deepLink}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink />
                Open the bot in Telegram
              </a>
            </Button>
          )}
        </div>
      ) : createTelegramLinkCode.isPending ? (
        <p className="text-sm">Generating your Telegram link…</p>
      ) : (
        <>
          <p className="text-sm">
            Link your own Telegram account so tasks you start from Telegram are
            attributed to you.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              createTelegramLinkCode.mutate(undefined, {
                onSuccess: (result) => setLinkCode(result),
              })
            }
            disabled={createTelegramLinkCode.isPending}
          >
            <LucideLink />
            {createTelegramLinkCode.isPending
              ? 'Generating code...'
              : 'Link your Telegram account'}
          </Button>
        </>
      )}
    </div>
  );
}
