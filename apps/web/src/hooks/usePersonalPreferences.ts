'use client';

import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';
import {
  DEFAULT_PERSONAL_PREFERENCES,
  type PersonalPreferences,
  type PersonalPreferencesUpdate,
} from '@/types/preferences';

type MutationContext = {
  previousPreferences: PersonalPreferences;
  optimisticPreferences: PersonalPreferences;
};

type UsePersonalPreferencesOptions = {
  enabled?: boolean;
  errorMessage?: string;
};

function mergePreferences(
  currentPreferences: PersonalPreferences | undefined,
  updates: PersonalPreferencesUpdate,
): PersonalPreferences {
  return {
    ...(currentPreferences ?? DEFAULT_PERSONAL_PREFERENCES),
    ...updates,
  };
}

function mergeResultForUpdatedFields(
  currentPreferences: PersonalPreferences | undefined,
  result: PersonalPreferences,
  updates: PersonalPreferencesUpdate,
): PersonalPreferences {
  const mergedPreferences = currentPreferences ?? DEFAULT_PERSONAL_PREFERENCES;

  return {
    colorTheme:
      updates.colorTheme === undefined
        ? mergedPreferences.colorTheme
        : result.colorTheme,
    mindReaderMode:
      updates.mindReaderMode === undefined
        ? mergedPreferences.mindReaderMode
        : result.mindReaderMode,
    narrationMode:
      updates.narrationMode === undefined
        ? mergedPreferences.narrationMode
        : result.narrationMode,
    resultsPageEnabled:
      updates.resultsPageEnabled === undefined
        ? mergedPreferences.resultsPageEnabled
        : result.resultsPageEnabled,
    slackPeerConversationsExperimentEnabled:
      updates.slackPeerConversationsExperimentEnabled === undefined
        ? mergedPreferences.slackPeerConversationsExperimentEnabled
        : result.slackPeerConversationsExperimentEnabled,
    homeComposerSuggestionsEnabled:
      updates.homeComposerSuggestionsEnabled === undefined
        ? mergedPreferences.homeComposerSuggestionsEnabled
        : result.homeComposerSuggestionsEnabled,
    serviceCredentialToolsEnabled:
      updates.serviceCredentialToolsEnabled === undefined
        ? mergedPreferences.serviceCredentialToolsEnabled
        : result.serviceCredentialToolsEnabled,
    privateSessionsExperimentEnabled:
      updates.privateSessionsExperimentEnabled === undefined
        ? mergedPreferences.privateSessionsExperimentEnabled
        : result.privateSessionsExperimentEnabled,
  };
}

function rollbackUpdatedFields(
  currentPreferences: PersonalPreferences | undefined,
  updates: PersonalPreferencesUpdate,
  context: MutationContext | undefined,
): PersonalPreferences {
  const mergedPreferences = currentPreferences ?? DEFAULT_PERSONAL_PREFERENCES;
  const previousPreferences =
    context?.previousPreferences ?? DEFAULT_PERSONAL_PREFERENCES;
  const optimisticPreferences =
    context?.optimisticPreferences ?? mergedPreferences;

  return {
    colorTheme:
      updates.colorTheme !== undefined &&
      mergedPreferences.colorTheme === optimisticPreferences.colorTheme
        ? previousPreferences.colorTheme
        : mergedPreferences.colorTheme,
    mindReaderMode:
      updates.mindReaderMode !== undefined &&
      mergedPreferences.mindReaderMode === optimisticPreferences.mindReaderMode
        ? previousPreferences.mindReaderMode
        : mergedPreferences.mindReaderMode,
    narrationMode:
      updates.narrationMode !== undefined &&
      mergedPreferences.narrationMode === optimisticPreferences.narrationMode
        ? previousPreferences.narrationMode
        : mergedPreferences.narrationMode,
    resultsPageEnabled:
      updates.resultsPageEnabled !== undefined &&
      mergedPreferences.resultsPageEnabled ===
        optimisticPreferences.resultsPageEnabled
        ? previousPreferences.resultsPageEnabled
        : mergedPreferences.resultsPageEnabled,
    slackPeerConversationsExperimentEnabled:
      updates.slackPeerConversationsExperimentEnabled !== undefined &&
      mergedPreferences.slackPeerConversationsExperimentEnabled ===
        optimisticPreferences.slackPeerConversationsExperimentEnabled
        ? previousPreferences.slackPeerConversationsExperimentEnabled
        : mergedPreferences.slackPeerConversationsExperimentEnabled,
    homeComposerSuggestionsEnabled:
      updates.homeComposerSuggestionsEnabled !== undefined &&
      mergedPreferences.homeComposerSuggestionsEnabled ===
        optimisticPreferences.homeComposerSuggestionsEnabled
        ? previousPreferences.homeComposerSuggestionsEnabled
        : mergedPreferences.homeComposerSuggestionsEnabled,
    serviceCredentialToolsEnabled:
      updates.serviceCredentialToolsEnabled !== undefined &&
      mergedPreferences.serviceCredentialToolsEnabled ===
        optimisticPreferences.serviceCredentialToolsEnabled
        ? previousPreferences.serviceCredentialToolsEnabled
        : mergedPreferences.serviceCredentialToolsEnabled,
    privateSessionsExperimentEnabled:
      updates.privateSessionsExperimentEnabled !== undefined &&
      mergedPreferences.privateSessionsExperimentEnabled ===
        optimisticPreferences.privateSessionsExperimentEnabled
        ? previousPreferences.privateSessionsExperimentEnabled
        : mergedPreferences.privateSessionsExperimentEnabled,
  };
}

export function usePersonalPreferences(
  options: UsePersonalPreferencesOptions = {},
) {
  const { enabled = true, errorMessage } = options;
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const preferencesQueryKey = trpc.preferences.getPersonal.queryKey();

  const preferencesQuery = useQuery(
    trpc.preferences.getPersonal.queryOptions(undefined, {
      enabled,
    }),
  );

  const updatePreferences = useMutation(
    trpc.preferences.updatePersonal.mutationOptions({
      onMutate: async (variables): Promise<MutationContext> => {
        await queryClient.cancelQueries({ queryKey: preferencesQueryKey });

        const previousPreferences =
          queryClient.getQueryData<PersonalPreferences>(preferencesQueryKey) ??
          preferencesQuery.data ??
          DEFAULT_PERSONAL_PREFERENCES;
        const optimisticPreferences = mergePreferences(
          previousPreferences,
          variables,
        );

        queryClient.setQueryData<PersonalPreferences>(
          preferencesQueryKey,
          optimisticPreferences,
        );

        return {
          previousPreferences,
          optimisticPreferences,
        };
      },
      onSuccess: (result, variables) => {
        queryClient.setQueryData<PersonalPreferences>(
          preferencesQueryKey,
          (currentPreferences) =>
            mergeResultForUpdatedFields(currentPreferences, result, variables),
        );
      },
      onError: (_error, variables, context) => {
        queryClient.setQueryData<PersonalPreferences>(
          preferencesQueryKey,
          (currentPreferences) =>
            rollbackUpdatedFields(currentPreferences, variables, context),
        );

        if (errorMessage) {
          toast.error(errorMessage);
        }
      },
      onSettled: () => {
        void queryClient.invalidateQueries({
          queryKey: preferencesQueryKey,
        });
      },
    }),
  );

  const setPreferences = useCallback(
    (updates: PersonalPreferencesUpdate) => {
      updatePreferences.mutate(updates);
    },
    [updatePreferences],
  );

  return {
    preferences: preferencesQuery.data ?? DEFAULT_PERSONAL_PREFERENCES,
    error: preferencesQuery.error,
    hasLoadedPreferences: preferencesQuery.data !== undefined,
    isFetching: preferencesQuery.isFetching,
    isLoading: preferencesQuery.isPending,
    isUpdating: updatePreferences.isPending,
    refetch: preferencesQuery.refetch,
    setPreferences,
  };
}
