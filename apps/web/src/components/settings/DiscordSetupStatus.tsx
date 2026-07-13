'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type { DiscordCommsStatus } from '@/trpc/commands/comms';
import { useTRPC } from '@/trpc/client';
import {
  Button,
  Check,
  ExternalLink,
  RefreshCw,
  Spinner,
  TriangleAlert,
} from '@/components/system';

import { DiscordLinkAccountStep } from './DiscordLinkAccountStep';

function DiagnosticRow({
  ok,
  label,
  detail,
}: {
  ok: boolean;
  label: string;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-2">
      {ok ? (
        <Check className="mt-0.5 size-4 shrink-0 text-green-600" />
      ) : (
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
      )}
      <p className="text-sm">
        <span className="font-medium text-foreground">{label}:</span> {detail}
      </p>
    </div>
  );
}

export function DiscordSetupStatus({ status }: { status: DiscordCommsStatus }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const repair = useMutation(
    trpc.comms.repairDiscord.mutationOptions({
      onSuccess: async () => {
        toast.success('Discord connection repaired.');
        await queryClient.invalidateQueries({
          queryKey: trpc.comms.status.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const identityReady = Boolean(
    status.bot.applicationId && status.bot.userId && status.bot.username,
  );
  const gatewayReady = status.gateway?.ready === true;
  const commandsReady = status.commands.status === 'registered';
  const messageContentReady = status.messageContentIntent === 'enabled';

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-muted-foreground">
        <DiagnosticRow
          ok={identityReady}
          label="Bot identity"
          detail={
            identityReady
              ? `Connected as @${status.bot.username}`
              : 'Discord could not validate the saved bot token.'
          }
        />
        <DiagnosticRow
          ok={gatewayReady}
          label="Gateway"
          detail={
            gatewayReady
              ? 'Connected and receiving Discord events.'
              : (status.gateway?.lastError ??
                'The Discord Gateway service is not ready yet.')
          }
        />
        <DiagnosticRow
          ok={messageContentReady}
          label="Message Content intent"
          detail={
            status.messageContentIntent === 'enabled'
              ? 'Enabled.'
              : status.messageContentIntent === 'disabled'
                ? 'Enable it under Bot → Privileged Gateway Intents in the Discord Developer Portal.'
                : 'Roomote could not verify this intent.'
          }
        />
        <DiagnosticRow
          ok={commandsReady}
          label="Slash commands"
          detail={
            commandsReady
              ? '/new, /link, and /help are registered.'
              : status.commands.status === 'missing'
                ? 'One or more Roomote commands are missing.'
                : 'Roomote could not verify command registration.'
          }
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {status.inviteUrl ? (
          <Button asChild variant="outline" size="sm">
            <a
              href={status.inviteUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink />
              Add to Discord
            </a>
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={repair.isPending}
          onClick={() => repair.mutate()}
        >
          {repair.isPending ? <Spinner size="sm" /> : <RefreshCw />}
          Repair
        </Button>
      </div>

      <DiscordLinkAccountStep />
    </div>
  );
}
