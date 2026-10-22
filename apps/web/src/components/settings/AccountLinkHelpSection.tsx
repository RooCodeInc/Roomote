'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Section } from '@/components/settings';
import {
  AlertCircle,
  Button,
  Label,
  LucideLink,
  Skeleton,
  Textarea,
} from '@/components/system';
import { useTRPC } from '@/trpc/client';

export function AccountLinkHelpSection() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const queryKey = trpc.accessPolicy.accountLinkHelp.queryKey();
  const settingsQuery = useQuery(
    trpc.accessPolicy.accountLinkHelp.queryOptions(),
  );
  const [value, setValue] = useState('');
  const [savedValue, setSavedValue] = useState('');
  const isDirty = value !== savedValue;

  const updateMutation = useMutation(
    trpc.accessPolicy.setAccountLinkHelp.mutationOptions({
      onSuccess: (result) => {
        queryClient.setQueryData(queryKey, result);
        const nextValue = result.helpText ?? '';
        setValue(nextValue);
        setSavedValue(nextValue);
        toast.success('Account linking help saved.');
      },
      onError: (error) => toast.error(error.message),
      onSettled: () =>
        queryClient.invalidateQueries({
          queryKey,
        }),
    }),
  );

  const serverValue = settingsQuery.data?.helpText ?? '';

  useEffect(() => {
    if (settingsQuery.data && !isDirty) {
      setValue(serverValue);
      setSavedValue(serverValue);
    }
  }, [isDirty, serverValue, settingsQuery.data]);

  const footer =
    !isDirty && !updateMutation.isPending ? undefined : (
      <>
        <Button
          variant="outline"
          type="button"
          onClick={() => setValue(savedValue)}
          disabled={updateMutation.isPending}
        >
          Reset
        </Button>
        <Button
          type="button"
          onClick={() =>
            updateMutation.mutate({ helpText: value.trim() || null })
          }
          disabled={updateMutation.isPending}
        >
          {updateMutation.isPending ? 'Saving...' : 'Save'}
        </Button>
      </>
    );

  const loadError = (
    <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
      <AlertCircle className="size-4 shrink-0" />
      <p className="flex-1">
        {settingsQuery.data
          ? 'Failed to refresh account linking help.'
          : 'Failed to load account linking help.'}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={settingsQuery.isFetching}
        onClick={() => void settingsQuery.refetch()}
      >
        Retry
      </Button>
    </div>
  );

  return (
    <Section icon={LucideLink} title="Account linking help" footer={footer}>
      <p className="text-sm text-muted-foreground">
        Add deployment-specific help when Roomote asks someone to link an
        account before starting work, such as how to request an invite. This
        appears in source-control comments and Discord and Telegram prompts.
      </p>
      {settingsQuery.isPending ? (
        <Skeleton className="h-24 w-full max-w-2xl" />
      ) : (
        <>
          {settingsQuery.isError ? loadError : null}
          {settingsQuery.data ? (
            <div className="max-w-2xl space-y-2">
              <Label htmlFor="account-link-help-text" className="sr-only">
                Account linking help text
              </Label>
              <Textarea
                id="account-link-help-text"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                maxLength={1000}
                rows={3}
                placeholder="If you need an invite, ask an admin in Discord: https://discord.gg/..."
                disabled={updateMutation.isPending}
              />
              <p className="text-xs text-muted-foreground">
                Markdown links are supported. Plain text with a full URL works
                on every supported surface.
              </p>
            </div>
          ) : null}
        </>
      )}
    </Section>
  );
}
