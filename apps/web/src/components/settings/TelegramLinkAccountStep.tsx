'use client';

import { useState } from 'react';

import { Button, Check, ExternalLink, LucideLink } from '@/components/system';
import {
  useCreateTelegramLinkCode,
  useTelegramLinkedAccount,
} from '@/hooks/linked-accounts';

/**
 * Final step of the Telegram comms setup: link the admin's own Telegram
 * account. The deep link opens the bot with `/start <code>`, so one tap
 * covers first contact, primary-chat capture, and account linking.
 */
export function TelegramLinkAccountStep() {
  const telegramAccount = useTelegramLinkedAccount();
  const createTelegramLinkCode = useCreateTelegramLinkCode();
  const [linkCode, setLinkCode] = useState<{
    code: string;
    expiresInSeconds: number;
    deepLink: string | null;
  } | null>(null);

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
        <>
          <p className="text-sm">
            Send this code to the bot within{' '}
            {Math.round(linkCode.expiresInSeconds / 60)} minutes to link your
            Telegram account:
          </p>
          <p>
            <code className="rounded bg-muted px-2 py-1 font-mono text-sm select-all ph-no-capture">
              {linkCode.code}
            </code>
          </p>
          {linkCode.deepLink && (
            <Button asChild variant="outline" size="sm">
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
        </>
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
