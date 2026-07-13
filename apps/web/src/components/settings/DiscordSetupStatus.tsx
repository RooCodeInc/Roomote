'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type { DiscordCommsStatus } from '@/trpc/commands/comms';
import { useTRPC } from '@/trpc/client';
import {
  Button,
  Check,
  ExternalLink,
  Info,
  RefreshCw,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
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
  const initiallySelectedGuildId =
    status.installations.find((installation) => installation.defaultChannelId)
      ?.guildId ??
    status.installations[0]?.guildId ??
    null;
  const [selectedGuildId, setSelectedGuildId] = useState<string | null>(
    initiallySelectedGuildId,
  );
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    status.installations.find(
      (installation) => installation.guildId === initiallySelectedGuildId,
    )?.defaultChannelId ?? null,
  );

  const guilds = useQuery(
    trpc.comms.listDiscordGuilds.queryOptions(undefined, {
      enabled: Boolean(status.bot.applicationId),
    }),
  );
  const channels = useQuery(
    trpc.comms.listDiscordChannels.queryOptions(
      { guildId: selectedGuildId ?? '' },
      { enabled: Boolean(selectedGuildId) },
    ),
  );
  const permissions = useQuery(
    trpc.comms.diagnoseDiscordPermissions.queryOptions(
      {
        guildId: selectedGuildId ?? '',
        channelId: selectedChannelId ?? '',
      },
      { enabled: Boolean(selectedGuildId && selectedChannelId) },
    ),
  );
  const saveDestination = useMutation(
    trpc.comms.selectDiscordDestination.mutationOptions({
      onSuccess: async () => {
        toast.success('Discord destination saved.');
        await queryClient.invalidateQueries({
          queryKey: trpc.comms.status.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const repair = useMutation(
    trpc.comms.repairDiscord.mutationOptions({
      onSuccess: async () => {
        toast.success('Discord connection repaired.');
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.comms.status.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.comms.listDiscordGuilds.queryKey(),
          }),
        ]);
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const guildOptions = useMemo(
    () => guilds.data?.guilds ?? [],
    [guilds.data?.guilds],
  );
  const selectedGuild = guildOptions.find(
    (guild) => guild.id === selectedGuildId,
  );
  const channelOptions = channels.data?.channels ?? [];
  const selectedChannel = channelOptions.find(
    (channel) => channel.id === selectedChannelId,
  );
  const savedDestination = status.installations.find(
    (installation) => installation.guildId === selectedGuildId,
  );
  const destinationDirty =
    Boolean(selectedChannelId) &&
    selectedChannelId !== savedDestination?.defaultChannelId;

  useEffect(() => {
    if (selectedGuildId || guildOptions.length === 0) return;
    const guild =
      guildOptions.find((candidate) => candidate.defaultChannelId) ??
      guildOptions[0];
    setSelectedGuildId(guild?.id ?? null);
    setSelectedChannelId(guild?.defaultChannelId ?? null);
  }, [guildOptions, selectedGuildId]);

  useEffect(() => {
    if (!selectedGuildId) return;
    const guild = guildOptions.find(
      (candidate) => candidate.id === selectedGuildId,
    );
    setSelectedChannelId(guild?.defaultChannelId ?? null);
  }, [guildOptions, selectedGuildId]);

  const missingPermissionLabel = useMemo(
    () =>
      (permissions.data?.missingPermissions ?? [])
        .map((permission) => permission.replaceAll('_', ' '))
        .join(', '),
    [permissions.data?.missingPermissions],
  );

  const identityReady = Boolean(
    status.bot.applicationId && status.bot.userId && status.bot.username,
  );
  const gatewayReady = status.gateway?.ready === true;
  const commandsReady = status.commands.status === 'registered';
  const messageContentReady = status.messageContentIntent === 'enabled';
  const permissionsReady = permissions.data?.canUseChannel === true;
  const selectedChannelRequiresTag = selectedChannel?.requiresTag === true;

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

      <div className="space-y-3 max-w-xl">
        <div className="space-y-1">
          <p className="text-sm font-medium">Default Discord destination</p>
          <p className="text-sm text-muted-foreground">
            Proactive work starts a separate task thread or forum post here.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Select
            value={selectedGuildId ?? ''}
            disabled={guilds.isPending || guilds.isError}
            onValueChange={setSelectedGuildId}
          >
            <SelectTrigger aria-label="Discord server">
              <span className="truncate text-left">
                {selectedGuild?.name ??
                  (guilds.isPending ? 'Loading servers…' : 'Select a server')}
              </span>
            </SelectTrigger>
            <SelectContent>
              {guildOptions.map((guild) => (
                <SelectItem key={guild.id} value={guild.id}>
                  {guild.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={selectedChannelId ?? ''}
            disabled={
              !selectedGuildId || channels.isPending || channels.isError
            }
            onValueChange={setSelectedChannelId}
          >
            <SelectTrigger aria-label="Discord channel">
              <span className="truncate text-left">
                {selectedChannel
                  ? `${selectedChannel.kind === 'forum' ? 'Forum' : '#'}${selectedChannel.name}`
                  : channels.isPending
                    ? 'Loading channels…'
                    : 'Select a channel'}
              </span>
            </SelectTrigger>
            <SelectContent>
              {channelOptions.map((channel) => (
                <SelectItem
                  key={channel.id}
                  value={channel.id}
                  disabled={!channel.supported}
                >
                  {channel.kind === 'forum' ? 'Forum: ' : '#'}
                  {channel.name}
                  {channel.requiresTag ? ' (requires a tag — unsupported)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {guilds.isError ? (
          <div className="flex items-start gap-2 text-sm text-destructive">
            <Info className="mt-0.5 size-4 shrink-0" />
            Add Roomote to a Discord server, then run Repair to refresh the
            server list.
          </div>
        ) : guildOptions.length === 0 && !guilds.isPending ? (
          <p className="text-sm text-muted-foreground">
            Add Roomote to a server, then run Repair to load its channels.
          </p>
        ) : null}
        {selectedChannelId && permissions.isPending ? (
          <p className="text-sm text-muted-foreground">
            Checking channel permissions…
          </p>
        ) : permissions.data ? (
          <DiagnosticRow
            ok={permissionsReady}
            label="Channel permissions"
            detail={
              permissions.data.unsupportedReason === 'forum_requires_tag'
                ? 'This forum requires a tag for every post. Turn off Require Tag in Discord or choose another channel.'
                : permissionsReady
                  ? 'Roomote can create and reply in task threads here.'
                  : `Missing: ${missingPermissionLabel}`
            }
          />
        ) : null}
        <Button
          type="button"
          disabled={
            !selectedGuildId ||
            !selectedChannelId ||
            !destinationDirty ||
            selectedChannelRequiresTag ||
            !permissionsReady ||
            saveDestination.isPending
          }
          onClick={() => {
            if (!selectedGuildId || !selectedChannelId) return;
            saveDestination.mutate({
              guildId: selectedGuildId,
              channelId: selectedChannelId,
            });
          }}
        >
          {saveDestination.isPending ? <Spinner size="sm" /> : <Check />}
          Save destination
        </Button>
      </div>

      <DiscordLinkAccountStep />
    </div>
  );
}
