'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';
import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '@/components/system';

/**
 * Picks the server channel Roomote posts to proactively (automation
 * suggestions, reports, and other messages that are not replies to an
 * existing conversation). Uses the comms Discord destination endpoints, which
 * validate channel type and bot permissions before saving.
 */
export function DiscordDefaultChannelPicker() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const guilds = useQuery(trpc.comms.listDiscordGuilds.queryOptions());
  const [selectedGuildId, setSelectedGuildId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    null,
  );

  const currentGuild = useMemo(
    () =>
      guilds.data?.guilds.find((guild) => guild.defaultChannelId !== null) ??
      null,
    [guilds.data?.guilds],
  );
  const effectiveGuildId =
    selectedGuildId ??
    currentGuild?.id ??
    (guilds.data?.guilds.length === 1 ? guilds.data.guilds[0]!.id : null);

  const channels = useQuery(
    trpc.comms.listDiscordChannels.queryOptions(
      { guildId: effectiveGuildId ?? '' },
      { enabled: effectiveGuildId !== null },
    ),
  );

  const savedChannelId =
    effectiveGuildId === currentGuild?.id
      ? (currentGuild?.defaultChannelId ?? null)
      : null;
  const effectiveChannelId = selectedChannelId ?? savedChannelId;

  // Reset the channel choice when the admin switches servers so a channel id
  // from the previous server can never be submitted against the new one.
  useEffect(() => {
    setSelectedChannelId(null);
  }, [effectiveGuildId]);

  const save = useMutation(
    trpc.comms.selectDiscordDestination.mutationOptions({
      onSuccess: async () => {
        toast.success('Default Discord channel saved.');
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.comms.listDiscordGuilds.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.comms.status.queryKey(),
          }),
        ]);
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  if (guilds.isPending) {
    return null;
  }

  if (guilds.isError || (guilds.data?.guilds.length ?? 0) === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <Label>Default channel</Label>
      <p className="text-sm text-muted-foreground">
        Where Roomote posts suggestions, reports, and other proactive updates.
        Replies always stay in the conversation they started in.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {guilds.data.guilds.length > 1 ? (
          <Select
            value={effectiveGuildId ?? undefined}
            onValueChange={(value) => setSelectedGuildId(value)}
          >
            <SelectTrigger className="w-56">
              <SelectValue placeholder="Choose a server" />
            </SelectTrigger>
            <SelectContent>
              {guilds.data.guilds.map((guild) => (
                <SelectItem key={guild.id} value={guild.id}>
                  {guild.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Select
          value={effectiveChannelId ?? undefined}
          onValueChange={(value) => setSelectedChannelId(value)}
          disabled={effectiveGuildId === null || channels.isPending}
        >
          <SelectTrigger className="w-56">
            <SelectValue
              placeholder={
                channels.isPending && effectiveGuildId !== null
                  ? 'Loading channels…'
                  : 'Choose a channel'
              }
            />
          </SelectTrigger>
          <SelectContent>
            {(channels.data?.channels ?? []).map((channel) => (
              <SelectItem
                key={channel.id}
                value={channel.id}
                disabled={!channel.supported}
              >
                #{channel.name}
                {channel.kind === 'forum' ? ' (forum)' : ''}
                {channel.supported ? '' : ' — no available tag'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={
            save.isPending ||
            effectiveGuildId === null ||
            effectiveChannelId === null ||
            effectiveChannelId === savedChannelId
          }
          onClick={() => {
            if (!effectiveGuildId || !effectiveChannelId) return;
            save.mutate({
              guildId: effectiveGuildId,
              channelId: effectiveChannelId,
            });
          }}
        >
          {save.isPending ? <Spinner size="sm" /> : null}
          Save
        </Button>
      </div>
      {savedChannelId && currentGuild?.defaultChannelName ? (
        <p className="text-sm text-muted-foreground">
          Currently posting to #{currentGuild.defaultChannelName}.
        </p>
      ) : null}
    </div>
  );
}
