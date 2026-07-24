'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';
import { Button, ExternalLink, Spinner } from '@/components/system';

const PAIRING_POLL_INTERVAL_MS = 2_000;

export type TelegramPairingSuccess = {
  botUsername: string | null;
  webhookWarning: string | null;
};

/**
 * Automatic Telegram bot creation via Telegram's Managed Bots feature: the
 * manager bot requests a deployment-owned bot, and the pairing service
 * hands the token straight to the server, so the admin never touches
 * BotFather or copies a token.
 */
export function TelegramManagedBotPairing({
  onPaired,
  disabled,
}: {
  onPaired: (result: TelegramPairingSuccess) => void;
  disabled?: boolean;
}) {
  const trpc = useTRPC();
  const [pairing, setPairing] = useState<{
    pairingId: string;
    deepLink: string;
  } | null>(null);
  const [expired, setExpired] = useState(false);
  const pollBusyRef = useRef(false);
  const lastErrorRef = useRef<string | null>(null);
  const autoStartedRef = useRef(false);

  const start = useMutation(
    trpc.comms.startTelegramPairing.mutationOptions({
      onSuccess: (result) => {
        setExpired(false);
        setPairing({ pairingId: result.pairingId, deepLink: result.deepLink });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const check = useMutation(trpc.comms.checkTelegramPairing.mutationOptions());
  const checkMutateAsync = check.mutateAsync;

  const startMutate = start.mutate;
  useEffect(() => {
    if (disabled || autoStartedRef.current) {
      return;
    }

    autoStartedRef.current = true;
    startMutate();
  }, [disabled, startMutate]);

  useEffect(() => {
    if (!pairing) {
      return;
    }

    const interval = setInterval(async () => {
      if (pollBusyRef.current) {
        return;
      }
      pollBusyRef.current = true;
      try {
        const result = await checkMutateAsync({
          pairingId: pairing.pairingId,
        });
        if (result.status === 'ready') {
          lastErrorRef.current = null;
          setPairing(null);
          onPaired({
            botUsername: result.botUsername,
            webhookWarning:
              result.telegramWebhook && !result.telegramWebhook.registered
                ? (result.telegramWebhook.error ?? 'unknown error')
                : null,
          });
        } else if (result.status === 'expired') {
          setPairing(null);
          setExpired(true);
        }
      } catch (error) {
        // Keep polling: the server stashes a retrieved token, so a failed
        // save attempt is retried on the next tick. Toast once per distinct
        // error so a stuck save is visible without spamming.
        const message =
          error instanceof Error
            ? error.message
            : 'Telegram pairing failed. Retrying…';
        if (lastErrorRef.current !== message) {
          lastErrorRef.current = message;
          toast.error(message);
        }
      } finally {
        pollBusyRef.current = false;
      }
    }, PAIRING_POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [pairing, checkMutateAsync, onPaired]);

  if (pairing) {
    return (
      <div className="space-y-4">
        <p>
          Scan this QR code with your phone, or open the link on this device. In
          Telegram, tap <span className="font-medium">Start</span>, then{' '}
          <span className="font-medium">Create Bot</span>. You can edit the
          bot&apos;s name or username before confirming.
        </p>
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <div className="rounded-lg bg-white p-3">
            <QRCodeSVG value={pairing.deepLink} size={168} />
          </div>
          <div className="space-y-3">
            <Button asChild variant="outline">
              <a
                href={pairing.deepLink}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open in Telegram <ExternalLink />
              </a>
            </Button>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner />
              Waiting for you to confirm in Telegram…
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p>
        Roomote can create your Telegram bot for you — no BotFather or token
        copy-paste. Follow the prompts in Telegram, choose the name and username
        you want, and Roomote connects it automatically.
      </p>
      {expired || start.isError ? (
        <>
          <p className="text-sm text-muted-foreground">
            {expired
              ? 'That pairing expired before the bot was created.'
              : 'Telegram setup could not be prepared.'}
          </p>
          <Button
            type="button"
            disabled={disabled || start.isPending}
            onClick={() => {
              setExpired(false);
              start.reset();
              start.mutate();
            }}
          >
            Try again
            {start.isPending && <Spinner />}
          </Button>
        </>
      ) : (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          Preparing Telegram setup…
        </div>
      )}
    </div>
  );
}
