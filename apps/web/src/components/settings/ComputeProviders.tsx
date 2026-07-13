'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  isSetupProvisionableComputeProvider,
  type ComputeProvider,
  type SetupComputeStatus,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import {
  Alert,
  Cpu,
  Info,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@/components/system';

import { Section } from './Section';
import { ComputeProviderSection } from './ComputeProviderSection';

type ComputeProviderStatus = SetupComputeStatus['providers'][number];

function getDefaultProviderDisabledLabel(provider: ComputeProviderStatus) {
  if (provider.configSatisfied) {
    return '';
  }

  if (!provider.infrastructureSatisfied) {
    return ' (missing worker image)';
  }

  return ' (not configured)';
}

export function ComputeProviders() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const statusQueryKey = trpc.compute.status.queryKey();
  const envVarsQueryKey = trpc.environmentVariables.list.queryKey();

  const status = useQuery(
    trpc.compute.status.queryOptions(undefined, {
      // Poll while a worker base-image provisioning run is in flight so the
      // page advances to the provisioned state without a manual refresh.
      refetchInterval: (query) =>
        Object.values(query.state.data?.provisioning ?? {}).some(
          (provisioning) => provisioning?.status === 'building',
        )
          ? 2_000
          : false,
    }),
  );
  const provisioningByProvider = status.data?.provisioning ?? {};

  const invalidateComputeQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: statusQueryKey }),
      queryClient.invalidateQueries({ queryKey: envVarsQueryKey }),
    ]);
  };

  const saveConfig = useMutation(
    trpc.compute.saveConfig.mutationOptions({
      onSuccess: async () => {
        await invalidateComputeQueries();
        toast.success('Sandbox provider configuration saved.');
      },
      onError: (error) => {
        toast.error(error.message || 'Failed to save configuration.');
      },
    }),
  );

  const clearConfig = useMutation(
    trpc.compute.clearConfig.mutationOptions({
      onSuccess: async () => {
        await invalidateComputeQueries();
        toast.success('Sandbox provider configuration cleared.');
      },
      onError: (error) => {
        toast.error(error.message || 'Failed to clear configuration.');
      },
    }),
  );

  const setDefaultProvider = useMutation(
    trpc.compute.setDefaultProvider.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: statusQueryKey });
        toast.success('Default sandbox provider updated.');
      },
      onError: (error) => {
        toast.error(error.message || 'Failed to update the default provider.');
      },
    }),
  );

  const setLocalDockerEnabled = useMutation(
    trpc.compute.setLocalDockerEnabled.mutationOptions({
      onSuccess: async () => {
        await invalidateComputeQueries();
        toast.success('Local Docker setting updated.');
      },
      onError: (error) => {
        toast.error(error.message || 'Failed to update Local Docker.');
      },
    }),
  );

  const providers: ComputeProviderStatus[] = status.data?.providers ?? [];
  const effectiveDefaultProvider: ComputeProvider =
    status.data?.persistedDefaultProvider ??
    status.data?.runtimeDefaultProvider ??
    'docker';
  const defaultProviderStatus = providers.find(
    (provider) => provider.provider === effectiveDefaultProvider,
  );
  const localDockerEnabled =
    !status.data?.excludedProviders?.includes('docker');

  const handleSave = (
    provider: ComputeProvider,
    values: Record<string, string>,
  ) => {
    saveConfig.mutate({ provider, values });
  };

  const handleClear = (provider: ComputeProvider) => {
    clearConfig.mutate({ provider });
  };

  if (status.isPending) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (status.isError) {
    return (
      <p className="text-sm text-destructive">
        Failed to load sandbox provider status.
      </p>
    );
  }

  if (providers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No sandbox providers are available.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <Section icon={Cpu} title="Default sandbox provider">
        <div className="max-w-xl space-y-3">
          <p className="text-sm text-muted-foreground">
            Roomote runs each task on an isolated sandbox. New tasks run on this
            provider unless a task explicitly overrides it.
          </p>
          <Select
            value={effectiveDefaultProvider}
            onValueChange={(value) =>
              setDefaultProvider.mutate({ provider: value as ComputeProvider })
            }
            disabled={setDefaultProvider.isPending}
          >
            <SelectTrigger className="w-full sm:w-72">
              <SelectValue placeholder="Select a sandbox provider" />
            </SelectTrigger>
            <SelectContent>
              {providers
                .filter(
                  (provider) =>
                    localDockerEnabled || provider.provider !== 'docker',
                )
                .map((provider) => (
                  <SelectItem
                    key={provider.provider}
                    value={provider.provider}
                    disabled={!provider.configSatisfied}
                  >
                    {provider.label}
                    {getDefaultProviderDisabledLabel(provider)}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          {defaultProviderStatus && !defaultProviderStatus.configSatisfied && (
            <Alert variant="notice">
              <Info className="size-4" />
              <p>
                {defaultProviderStatus.label} is the default sandbox provider
                but is missing configuration. Tasks may fail to start until it
                is configured or another default is selected.
              </p>
            </Alert>
          )}
        </div>
      </Section>
      {providers.map((provider) => (
        <ComputeProviderSection
          key={provider.provider}
          provider={provider}
          isDefault={provider.provider === effectiveDefaultProvider}
          provisioning={
            isSetupProvisionableComputeProvider(provider.provider)
              ? (provisioningByProvider[provider.provider] ?? null)
              : null
          }
          onSave={handleSave}
          onClear={handleClear}
          savePending={
            saveConfig.isPending &&
            saveConfig.variables?.provider === provider.provider
          }
          clearPending={
            clearConfig.isPending &&
            clearConfig.variables?.provider === provider.provider
          }
          localDockerEnabled={
            provider.provider === 'docker' ? localDockerEnabled : undefined
          }
          onLocalDockerToggle={
            provider.provider === 'docker'
              ? (enabled) => setLocalDockerEnabled.mutate({ enabled })
              : undefined
          }
          localDockerTogglePending={
            provider.provider === 'docker' && setLocalDockerEnabled.isPending
          }
        />
      ))}
    </div>
  );
}
