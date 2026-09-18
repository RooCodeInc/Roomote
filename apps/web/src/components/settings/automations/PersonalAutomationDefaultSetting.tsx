'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  getCommunicationProviderDisplayName,
  type AutomationDestinationProvider as DestinationProvider,
} from '@roomote/types';

import { useAuthorizedUser } from '@/hooks/useUser';
import { useTRPC } from '@/trpc/client';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  SendHorizontal,
  Skeleton,
} from '@/components/system';

import {
  AutomationDestinationPicker,
  type AutomationDestinationValue,
  destinationValueFromAutomationTarget,
} from './AutomationDestinationPicker';

const AUTOMATIC_DESTINATION: AutomationDestinationValue = {
  provider: 'none',
  mode: 'channel',
  channelId: '',
};

export function PersonalAutomationDefaultSetting() {
  const { isAdmin } = useAuthorizedUser();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const options = useQuery(
    trpc.automations.getCustomAutomationOptions.queryOptions(),
  );
  const slackChannels = useQuery(
    trpc.automations.listSlackChannels.queryOptions(undefined, {
      enabled: isAdmin && options.data?.capabilities.slackConnected === true,
    }),
  );
  const discordChannels = useQuery(
    trpc.automations.listDiscordChannels.queryOptions(undefined, {
      enabled: isAdmin && options.data?.capabilities.discordConnected === true,
    }),
  );
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<AutomationDestinationValue>(
    AUTOMATIC_DESTINATION,
  );

  useEffect(() => {
    setValue(
      destinationValueFromAutomationTarget(
        options.data?.configuredDefaultTarget ?? null,
      ),
    );
  }, [options.data?.configuredDefaultTarget]);

  const capabilities = options.data?.capabilities;
  const availableProviders = useMemo(
    () =>
      capabilities
        ? ([
            ...(capabilities.slackConnected ? ['slack'] : []),
            ...(capabilities.teamsConnected ? ['teams'] : []),
            ...(capabilities.telegramConnected ? ['telegram'] : []),
            ...(capabilities.discordConnected ? ['discord'] : []),
            ...(capabilities.emailConnected ? ['email'] : []),
          ] as DestinationProvider[])
        : [],
    [capabilities],
  );
  const slackOptions = useMemo(
    () =>
      (slackChannels.data?.channels ?? []).map((channel) => ({
        id: channel.id,
        name: channel.name,
        label: channel.name.startsWith('#') ? channel.name : `#${channel.name}`,
      })),
    [slackChannels.data?.channels],
  );
  const discordOptions = useMemo(
    () =>
      (discordChannels.data?.channels ?? []).map((channel) => ({
        id: channel.id,
        name: channel.name,
        label: channel.label ?? channel.name,
      })),
    [discordChannels.data?.channels],
  );
  const emailOptions = useMemo(
    () =>
      (options.data?.emailIdentities ?? []).map((identity) => ({
        id: identity.id,
        name: identity.emailAddress,
        label: `${identity.emailAddress} · Account email`,
      })),
    [options.data?.emailIdentities],
  );

  const update = useMutation(
    trpc.automations.updateCustomAutomationDefaultDestination.mutationOptions({
      onSuccess: async () => {
        toast.success('Default destination updated');
        setOpen(false);
        await queryClient.invalidateQueries({
          queryKey: trpc.automations.getCustomAutomationOptions.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  if (options.isPending) {
    return <Skeleton className="h-5 w-64" />;
  }

  const configured = destinationValueFromAutomationTarget(
    options.data?.configuredDefaultTarget ?? null,
  );
  const effective = destinationValueFromAutomationTarget(
    options.data?.defaultTarget ?? null,
  );
  const summary =
    configured.provider === 'none'
      ? `Automatic${effective.provider === 'none' ? '' : ` (${formatDestination(effective, slackOptions, discordOptions, emailOptions)})`}`
      : formatDestination(
          configured,
          slackOptions,
          discordOptions,
          emailOptions,
        );

  return (
    <>
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <SendHorizontal className="size-4" />
        <p>
          My default destination:{' '}
          <span className="font-medium text-foreground">{summary}</span>{' '}
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => setOpen(true)}
          >
            Edit
          </Button>
        </p>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Default destination</DialogTitle>
            <DialogDescription>
              Applies to new custom automations you create. Existing automations
              keep their explicit destinations.
            </DialogDescription>
          </DialogHeader>
          <AutomationDestinationPicker
            id="personal-automation-default"
            value={value}
            availableProviders={availableProviders}
            slackOptions={slackOptions}
            discordOptions={discordOptions}
            emailOptions={emailOptions}
            channelProviders={isAdmin ? ['slack', 'discord'] : []}
            channelCatalogAvailable={isAdmin}
            defaultSlackChannelId={
              slackOptions.some(
                (option) => option.id === options.data?.managerSlackChannelId,
              )
                ? (options.data?.managerSlackChannelId ?? '')
                : (slackOptions[0]?.id ?? '')
            }
            defaultDiscordChannelId={
              discordOptions.some(
                (option) => option.id === options.data?.managerDiscordChannelId,
              )
                ? (options.data?.managerDiscordChannelId ?? '')
                : (discordOptions[0]?.id ?? '')
            }
            defaultEmailIdentityId={emailOptions[0]?.id ?? ''}
            noneLabel="Automatic"
            noneDescription={
              isAdmin
                ? 'Uses the shared destination, then your linked DM or account email.'
                : 'Uses your first available linked DM, then your account email.'
            }
            disabled={update.isPending}
            onChange={setValue}
          />
          {!isAdmin ? (
            <p className="text-xs text-muted-foreground">
              Shared channel defaults are managed by deployment admins.
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={update.isPending}
              onClick={() => {
                setValue(configured);
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={
                update.isPending ||
                (value.provider !== 'none' &&
                  value.mode === 'channel' &&
                  !value.channelId) ||
                (value.provider === 'email' && !value.channelId)
              }
              onClick={() =>
                update.mutate(
                  value.provider === 'none'
                    ? {}
                    : {
                        targetProvider: value.provider,
                        targetMode: value.mode,
                        targetChannelId: value.channelId || undefined,
                      },
                )
              }
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function formatDestination(
  value: AutomationDestinationValue,
  slackOptions: Array<{ id: string; label: string }>,
  discordOptions: Array<{ id: string; label: string }>,
  emailOptions: Array<{ id: string; label: string }>,
) {
  if (value.provider === 'none') return 'Automatic';
  if (value.provider === 'email') {
    const email = emailOptions.find((option) => option.id === value.channelId);
    return `Email me${email ? ` at ${email.label.split(' · ')[0]}` : ''}`;
  }
  const provider = getCommunicationProviderDisplayName(value.provider);
  if (value.mode === 'direct_message') return `${provider} DM me`;
  const options = value.provider === 'slack' ? slackOptions : discordOptions;
  return `${provider} ${options.find((option) => option.id === value.channelId)?.label ?? value.channelId}`;
}
