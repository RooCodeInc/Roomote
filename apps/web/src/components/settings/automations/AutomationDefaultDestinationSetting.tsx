'use client';

import { type ReactNode, useEffect, useMemo, useState } from 'react';
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
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

export function AutomationDefaultDestinationSetting({
  sharedEditor,
  sharedDestinationLabel,
}: {
  sharedEditor?: ReactNode;
  sharedDestinationLabel?: string | null;
}) {
  const { isAdmin } = useAuthorizedUser();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const options = useQuery(
    trpc.automations.getCustomAutomationOptions.queryOptions(),
  );
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<'shared' | 'personal'>('personal');
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
  const personalSummary =
    configured.provider === 'none'
      ? `Automatic${!sharedEditor && effective.provider !== 'none' ? ` → ${formatDestination(effective, emailOptions)}` : ''}`
      : formatDestination(configured, emailOptions);
  const summary = [
    ...(configured.provider !== 'none'
      ? [`${personalSummary} · Personal`]
      : []),
    ...(sharedEditor
      ? [`${sharedDestinationLabel ?? 'Automatic'} · Shared`]
      : configured.provider === 'none'
        ? [`${personalSummary} · Personal`]
        : []),
  ].join(' / ');

  return (
    <>
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <SendHorizontal className="size-4" />
        <p>
          Default destination:{' '}
          <span className="font-medium text-foreground">{summary}</span>{' '}
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => {
              setScope(
                sharedEditor && configured.provider === 'none'
                  ? 'shared'
                  : 'personal',
              );
              setOpen(true);
            }}
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
              Channels are shared across the deployment. DMs and email apply
              only to new custom automations you create. Existing automations
              keep their explicit destinations.
            </DialogDescription>
          </DialogHeader>
          <Tabs
            value={scope}
            onValueChange={(nextScope) =>
              setScope(nextScope as 'shared' | 'personal')
            }
          >
            {sharedEditor ? (
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="shared">Shared channel</TabsTrigger>
                <TabsTrigger value="personal">Personal DM or email</TabsTrigger>
              </TabsList>
            ) : null}
            {sharedEditor ? (
              <TabsContent value="shared" className="space-y-4 pt-4">
                <p className="text-sm text-muted-foreground">
                  Used by built-in automations and as the default for new custom
                  automations when you have no personal selection.
                </p>
                {sharedEditor}
              </TabsContent>
            ) : null}
            <TabsContent value="personal" className="space-y-4 pt-4">
              <AutomationDestinationPicker
                id="personal-automation-default"
                label="Personal destination"
                value={value}
                availableProviders={availableProviders}
                slackOptions={[]}
                discordOptions={[]}
                emailOptions={emailOptions}
                channelProviders={[]}
                channelCatalogAvailable={false}
                defaultEmailIdentityId={emailOptions[0]?.id ?? ''}
                noneLabel="Automatic"
                noneDescription={
                  sharedEditor
                    ? `Uses the shared destination${sharedDestinationLabel ? ` (${sharedDestinationLabel})` : ''}, then your first available linked DM or account email.`
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
              {sharedEditor ? (
                <p className="text-xs text-muted-foreground">
                  This personal selection does not change the shared channel
                  used by built-in automations.
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
                    (value.provider === 'email' && !value.channelId)
                  }
                  onClick={() =>
                    update.mutate(
                      value.provider === 'none'
                        ? {}
                        : {
                            targetProvider: value.provider,
                            targetMode: 'direct_message',
                            targetChannelId: value.channelId || undefined,
                          },
                    )
                  }
                >
                  Save personal default
                </Button>
              </DialogFooter>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </>
  );
}

function formatDestination(
  value: AutomationDestinationValue,
  emailOptions: Array<{ id: string; label: string }>,
) {
  if (value.provider === 'none') return 'Automatic';
  if (value.provider === 'email') {
    const email = emailOptions.find((option) => option.id === value.channelId);
    return `Email me${email ? ` at ${email.label.split(' · ')[0]}` : ''}`;
  }
  const provider = getCommunicationProviderDisplayName(value.provider);
  if (value.mode === 'direct_message') return `${provider} DM me`;
  return provider;
}
