'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';
import { ArrowRight, Button, Spinner } from '@/components/system';
import { TelegramLinkAccountStep } from '@/components/settings/TelegramLinkAccountStep';
import { useTelegramLinkedAccount } from '@/hooks/linked-accounts';

import {
  getSetupEffectiveFieldValue,
  getSetupSubmitValues,
  getSetupVisibleFields,
  ProviderSetupExperience,
} from './ProviderSetupExperience';
import { StepTitle } from './StepTitle';
import { SetupFooter } from './SetupFooter';
import {
  TelegramManagedBotPairing,
  type TelegramPairingSuccess,
} from './TelegramManagedBotPairing';

export function StepTelegramSetup({
  onContinue,
  onBack,
}: {
  onContinue: () => void;
  onBack?: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const status = useQuery(trpc.comms.status.queryOptions());
  const telegramAccount = useTelegramLinkedAccount({ refetchInterval: 2_000 });
  const [credentialsSaved, setCredentialsSaved] = useState(false);
  const [useManualSetup, setUseManualSetup] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [editingSavedValues, setEditingSavedValues] = useState<
    Record<string, boolean>
  >({});
  const [clearedSavedValues, setClearedSavedValues] = useState<
    Record<string, boolean>
  >({});
  const provider = useMemo(
    () => status.data?.providers.find((item) => item.id === 'telegram') ?? null,
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
            queryKey: trpc.linkedAccounts.telegram.queryKey(),
          }),
        ]);
        if (result.telegramWebhook && !result.telegramWebhook.registered) {
          toast.warning(
            `Telegram was saved, but Roomote could not connect the bot: ${result.telegramWebhook.error ?? 'unknown error'}`,
          );
        }
        setCredentialsSaved(true);
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const isConfigured = credentialsSaved || provider?.setupSatisfied === true;
  const pairingAvailable = provider?.telegramPairingAvailable === true;
  const showAutomaticSetup =
    pairingAvailable && !isConfigured && !useManualSetup;
  const handlePaired = async (result: TelegramPairingSuccess) => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.comms.status.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.linkedAccounts.telegram.queryKey(),
      }),
    ]);
    if (result.webhookWarning) {
      toast.warning(
        `Your bot was created, but Roomote could not connect it: ${result.webhookWarning}`,
      );
    } else {
      toast.success(
        result.botUsername
          ? `@${result.botUsername} is connected.`
          : 'Your Telegram bot is connected.',
      );
    }
    setCredentialsSaved(true);
  };
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
      {provider && showAutomaticSetup ? (
        <div className="space-y-4">
          <StepTitle text="Connect Telegram" />
          <TelegramManagedBotPairing
            onPaired={handlePaired}
            disabled={status.isLoading}
          />
          <button
            type="button"
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
            onClick={() => setUseManualSetup(true)}
          >
            Enter a bot token manually instead
          </button>
        </div>
      ) : provider && !isConfigured ? (
        <div className="space-y-4">
          {pairingAvailable && (
            <button
              type="button"
              className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              onClick={() => setUseManualSetup(false)}
            >
              ← Use automatic setup instead
            </button>
          )}
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
        </div>
      ) : provider && isConfigured ? (
        <div className="space-y-4">
          <StepTitle text="Link your Telegram account" />
          <p>
            Open the bot and send the prefilled link command so Telegram lets
            Roomote message you and tasks are attributed to your account.
          </p>
          <TelegramLinkAccountStep pollUntilLinked autoGenerate />
        </div>
      ) : status.isError ? (
        <p className="text-sm text-destructive">
          Unable to load Telegram setup. Refresh and try again.
        </p>
      ) : (
        <Spinner />
      )}

      <SetupFooter onBack={onBack} className="mt-8">
        {showAutomaticSetup ? (
          <Button type="button" disabled>
            Continue <ArrowRight />
          </Button>
        ) : (
          <Button
            type="button"
            disabled={
              isConfigured ? !telegramAccount.data?.mapping : isActionDisabled
            }
            onClick={() => {
              if (isConfigured) {
                onContinue();
                return;
              }
              if (!provider) return;
              save.mutate({
                provider: 'telegram',
                values: getSetupSubmitValues({ provider, values }),
              });
            }}
          >
            {save.isPending
              ? 'Saving...'
              : isConfigured
                ? 'Continue'
                : 'Save and link account'}
            {save.isPending ? <Spinner /> : <ArrowRight />}
          </Button>
        )}
      </SetupFooter>
    </div>
  );
}
