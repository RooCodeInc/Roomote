'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';
import { ArrowRight, Button, Spinner } from '@/components/system';
import { DiscordLinkAccountStep } from '@/components/settings/DiscordLinkAccountStep';
import { useDiscordLinkedAccount } from '@/hooks/linked-accounts';

import {
  getSetupEffectiveFieldValue,
  getSetupSubmitValues,
  getSetupVisibleFields,
  ProviderSetupExperience,
} from './ProviderSetupExperience';
import { StepTitle } from './StepTitle';
import { SetupFooter } from './SetupFooter';

export function StepDiscordSetup({
  onContinue,
  onBack,
}: {
  onContinue: () => void;
  onBack?: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const status = useQuery(trpc.comms.status.queryOptions());
  const discordAccount = useDiscordLinkedAccount({ refetchInterval: 2_000 });
  const [credentialsSaved, setCredentialsSaved] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [editingSavedValues, setEditingSavedValues] = useState<
    Record<string, boolean>
  >({});
  const [clearedSavedValues, setClearedSavedValues] = useState<
    Record<string, boolean>
  >({});
  const provider = useMemo(
    () => status.data?.providers.find((item) => item.id === 'discord') ?? null,
    [status.data?.providers],
  );
  const visibleFields = getSetupVisibleFields(provider);
  const save = useMutation(
    trpc.comms.saveAuthConfig.mutationOptions({
      onSuccess: async (result) => {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.comms.status.queryKey(),
          }),
          queryClient.invalidateQueries({
            queryKey: trpc.linkedAccounts.discord.queryKey(),
          }),
        ]);
        if (result.discord && !result.discord.registered) {
          toast.warning(
            `Discord was saved, but Roomote could not finish connecting: ${result.discord.error ?? 'unknown error'}`,
          );
        }
        setCredentialsSaved(true);
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const isConfigured = credentialsSaved || provider?.setupSatisfied === true;
  const isActionDisabled =
    save.isPending ||
    status.isLoading ||
    !provider ||
    visibleFields.some((field) => {
      const value = getSetupEffectiveFieldValue({
        provider,
        field,
        values,
      }).trim();
      return (
        field.required !== false &&
        !field.runtimeSatisfied &&
        !field.savedSatisfied &&
        value.length === 0
      );
    });

  return (
    <div className="relative w-full max-w-2xl space-y-5 py-2 md:py-0">
      {provider && !isConfigured ? (
        <ProviderSetupExperience
          provider={provider}
          values={values}
          publicOrigin={
            typeof window === 'undefined'
              ? 'https://your-deployment-url'
              : window.location.origin
          }
          disabled={save.isPending}
          editingSavedValues={editingSavedValues}
          clearedSavedValues={clearedSavedValues}
          teamsAppPackageHref={null}
          onBack={onBack}
          onValueChange={(envVarName, value) =>
            setValues((current) => ({ ...current, [envVarName]: value }))
          }
          onEditingSavedValueChange={(envVarName, editing) =>
            setEditingSavedValues((current) => ({
              ...current,
              [envVarName]: editing,
            }))
          }
          onClearedSavedValueChange={(envVarName, cleared) =>
            setClearedSavedValues((current) => ({
              ...current,
              [envVarName]: cleared,
            }))
          }
        />
      ) : provider && isConfigured ? (
        <div className="space-y-4">
          <StepTitle text="Link Discord Account" />
          <DiscordLinkAccountStep />
        </div>
      ) : status.isError ? (
        <p className="text-sm text-destructive">
          Unable to load Discord setup. Refresh and try again.
        </p>
      ) : (
        <Spinner />
      )}

      <SetupFooter onBack={onBack} className="mt-8">
        <Button
          type="button"
          disabled={
            isConfigured ? !discordAccount.data?.mapping : isActionDisabled
          }
          onClick={() => {
            if (isConfigured) {
              onContinue();
              return;
            }
            if (!provider) return;
            save.mutate({
              provider: 'discord',
              values: getSetupSubmitValues({ provider, values }),
            });
          }}
        >
          {save.isPending
            ? 'Saving...'
            : isConfigured
              ? 'Continue'
              : 'Save and connect Discord'}
          {save.isPending ? <Spinner /> : <ArrowRight />}
        </Button>
      </SetupFooter>
    </div>
  );
}
