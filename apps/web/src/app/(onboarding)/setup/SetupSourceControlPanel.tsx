'use client';

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { SourceControlProvider } from '@roomote/types';

import { useTRPC } from '@/trpc/client';
import { buildSetupSessionSourceControlReturnTarget } from '@/lib/server/source-control-oauth-redirect';
import { Button } from '@/components/system';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/system/primitives/drawer';

import { StepSourceControlProvider } from './StepSourceControlProvider';
import { StepSourceControlConfig } from './StepSourceControlConfig';
import { StepSourceControlConnect } from './StepSourceControlConnect';

type SourceControlSetup = {
  connectedProvider: SourceControlProvider | null;
  selectedProvider: SourceControlProvider | null;
  runtimeConfiguredProvider: SourceControlProvider | null;
  preselectedProvider: SourceControlProvider;
  providers: Array<{
    provider: SourceControlProvider;
    label: string;
    connected: boolean;
    repositoryCount?: number;
  }>;
};

type PanelStage = 'provider' | 'config' | 'connect' | 'connected';

/**
 * Trusted source-control panel for the conversational setup workspace.
 * Reuses the bootstrap provider selection, configuration, documentation,
 * OAuth, sync, pending-approval, retry, and error components. Credential
 * entry and OAuth actions stay in this panel and never reach model messages.
 */
function SetupSourceControlPanel({
  sourceControlSetup,
  onConnected,
  compact = false,
  sessionId,
}: {
  sourceControlSetup: SourceControlSetup;
  onConnected?: () => void;
  compact?: boolean;
  sessionId: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const saveSourceControlProviderChoice = useMutation(
    trpc.setupNew.saveSourceControlProviderChoice.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.setupNew.status.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const anyAuthorized =
    Boolean(sourceControlSetup.connectedProvider) ||
    sourceControlSetup.providers.some((provider) => provider.connected);
  const anySynchronized = sourceControlSetup.providers.some(
    (provider) => provider.connected && (provider.repositoryCount ?? 0) > 0,
  );
  const hasSelected =
    Boolean(sourceControlSetup.selectedProvider) ||
    Boolean(sourceControlSetup.runtimeConfiguredProvider);

  const stage: PanelStage = anySynchronized
    ? 'connected'
    : anyAuthorized
      ? 'connect'
      : hasSelected
        ? 'config'
        : 'provider';

  const searchParams = useSearchParams();
  // OAuth callbacks deep-link back to /setup?step=source-control-connect;
  // treat that as a hint to show the connect/sync stage directly.
  const [showConnectStage, setShowConnectStage] = useState(
    () =>
      searchParams.get('step') === 'source-control-connect' ||
      searchParams.get('setup') === 'source-control',
  );
  const provider =
    sourceControlSetup.selectedProvider ??
    sourceControlSetup.runtimeConfiguredProvider ??
    sourceControlSetup.preselectedProvider;
  const returnPath = buildSetupSessionSourceControlReturnTarget({
    sessionId,
    provider,
  });
  const oauthError =
    searchParams.get(provider) === 'error'
      ? searchParams.get('reason') || `${provider} authorization was cancelled.`
      : null;

  return (
    <div
      className={
        compact
          ? 'space-y-4'
          : 'w-full max-w-md space-y-4 rounded-2xl border border-border bg-card p-4'
      }
    >
      {oauthError ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {oauthError}
        </p>
      ) : null}
      {stage === 'provider' ? (
        <StepSourceControlProvider
          sourceControlSetup={sourceControlSetup}
          onContinue={(provider) =>
            saveSourceControlProviderChoice.mutate({ provider })
          }
        />
      ) : stage === 'config' && !showConnectStage ? (
        <StepSourceControlConfig
          sourceControlSetup={sourceControlSetup as never}
          selectedProviderId={sourceControlSetup.selectedProvider}
          onContinue={() => setShowConnectStage(true)}
          returnPath={returnPath}
        />
      ) : stage === 'connect' || showConnectStage ? (
        <StepSourceControlConnect
          sourceControlSetup={sourceControlSetup as never}
          onContinue={() => {
            setShowConnectStage(false);
            onConnected?.();
          }}
          returnPath={returnPath}
        />
      ) : (
        <div className="space-y-2">
          <p className="text-sm font-medium">Source control connected</p>
          <p className="text-sm text-muted-foreground">
            Repositories are syncing. Roomote can offer starter tasks now.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Responsive wrapper: a static side panel on desktop and a controlled drawer
 * sheet on smaller screens, rendering the same trusted panel content.
 */
function SetupSourceControlPanelSurface({
  sourceControlSetup,
  onConnected,
  sessionId,
}: {
  sourceControlSetup: SourceControlSetup;
  onConnected?: () => void;
  sessionId: string;
}) {
  const anySynchronized = sourceControlSetup.providers.some(
    (provider) => provider.connected && (provider.repositoryCount ?? 0) > 0,
  );
  const [sheetOpen, setSheetOpen] = useState(!anySynchronized);

  return (
    <>
      <div className="hidden h-full shrink-0 lg:block">
        <SetupSourceControlPanel
          sourceControlSetup={sourceControlSetup}
          onConnected={onConnected}
          sessionId={sessionId}
        />
      </div>
      <div className="lg:hidden">
        <Drawer open={sheetOpen} onOpenChange={setSheetOpen}>
          <DrawerTrigger asChild>
            <Button variant="outline" size="sm" className="w-full">
              {anySynchronized
                ? 'Source control connected'
                : 'Connect source control'}
            </Button>
          </DrawerTrigger>
          <DrawerContent className="max-h-[85vh] overflow-y-auto">
            <DrawerHeader>
              <DrawerTitle>Connect source control</DrawerTitle>
            </DrawerHeader>
            <div className="px-4 pb-6">
              <SetupSourceControlPanel
                sourceControlSetup={sourceControlSetup}
                onConnected={() => setSheetOpen(false)}
                sessionId={sessionId}
                compact
              />
            </div>
          </DrawerContent>
        </Drawer>
      </div>
    </>
  );
}

function useSetupSourceControlStatus(enabled: boolean) {
  const trpc = useTRPC();
  const statusQuery = useQuery(
    trpc.setupNew.status.queryOptions(undefined, {
      enabled,
      staleTime: 10_000,
    }),
  );
  const sourceControlSetup = statusQuery.data?.sourceControlSetup ?? null;
  const connectedProviderCount = useMemo(
    () =>
      sourceControlSetup?.providers.filter(
        (provider) => provider.connected && (provider.repositoryCount ?? 0) > 0,
      ).length ?? 0,
    [sourceControlSetup],
  );
  return { statusQuery, sourceControlSetup, connectedProviderCount };
}

export function SetupSessionSourceControlPanel({
  sessionId,
}: {
  sessionId: string;
}) {
  const { sourceControlSetup, connectedProviderCount } =
    useSetupSourceControlStatus(true);
  if (!sourceControlSetup || connectedProviderCount > 0) return null;
  return (
    <div className="shrink-0 overflow-y-auto p-3 lg:w-[24rem]">
      <SetupSourceControlPanelSurface
        sourceControlSetup={sourceControlSetup}
        sessionId={sessionId}
      />
    </div>
  );
}
