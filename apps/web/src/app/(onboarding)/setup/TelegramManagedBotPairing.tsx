'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
 * Automatic Telegram bot creation via Telegram's Managed Bots feature: one
 * tap in Telegram creates a deployment-owned bot, and the pairing service
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

  const stopPairing = useCallback(() => {
    setPairing(null);
  }, []);

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
        setPairing(null);
        toast.error(
          error instanceof Error
            ? error.message
            : 'Telegram pairing failed. Try again.',
        );
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
          Scan this QR code with your phone, or open the link on this device.
          When Telegram opens, tap{' '}
          <span className="font-medium">Create Bot</span> to confirm.
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
            <Button variant="ghost" size="sm" onClick={stopPairing}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p>
        Roomote can create your Telegram bot for you — no BotFather, no token
        copy-paste. You confirm the new bot with one tap in Telegram and Roomote
        connects it automatically.
      </p>
      {expired && (
        <p className="text-sm text-muted-foreground">
          That pairing expired before the bot was created. Start again when
          you&apos;re ready.
        </p>
      )}
      <Button
        type="button"
        disabled={disabled || start.isPending}
        onClick={() => start.mutate()}
      >
        {start.isPending ? 'Preparing…' : 'Create my Telegram bot'}
        {start.isPending && <Spinner />}
      </Button>
    </div>
  );
}
