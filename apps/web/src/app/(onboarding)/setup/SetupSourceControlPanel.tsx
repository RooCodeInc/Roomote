'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { SourceControlProvider } from '@roomote/types';

import { useTRPC } from '@/trpc/client';
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
}: {
  sourceControlSetup: SourceControlSetup;
  onConnected?: () => void;
  compact?: boolean;
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

  const anyConnected =
    Boolean(sourceControlSetup.connectedProvider) ||
    sourceControlSetup.providers.some((provider) => provider.connected);
  const hasSelected =
    Boolean(sourceControlSetup.selectedProvider) ||
    Boolean(sourceControlSetup.runtimeConfiguredProvider);

  const stage: PanelStage = anyConnected
    ? 'connected'
    : hasSelected
      ? 'config'
      : 'provider';

  const searchParams = useSearchParams();
  // OAuth callbacks deep-link back to /setup?step=source-control-connect;
  // treat that as a hint to show the connect/sync stage directly.
  const [showConnectStage, setShowConnectStage] = useState(
    () => searchParams.get('step') === 'source-control-connect',
  );

  return (
    <div
      className={
        compact
          ? 'space-y-4'
          : 'w-full max-w-md space-y-4 rounded-2xl border border-border bg-card p-4'
      }
    >
      {stage === 'provider' ? (
        <StepSourceControlProvider
          sourceControlSetup={sourceControlSetup}
          onContinue={(provider) =>
            saveSourceControlProviderChoice.mutate({ provider })
          }
        />
      ) : stage === 'config' ? (
        <StepSourceControlConfig
          sourceControlSetup={sourceControlSetup as never}
          selectedProviderId={sourceControlSetup.selectedProvider}
          onContinue={() => setShowConnectStage(true)}
        />
      ) : showConnectStage ? (
        <StepSourceControlConnect
          sourceControlSetup={sourceControlSetup as never}
          onContinue={() => {
            setShowConnectStage(false);
            onConnected?.();
          }}
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
export function SetupSourceControlPanelSurface({
  sourceControlSetup,
  onConnected,
}: {
  sourceControlSetup: SourceControlSetup;
  onConnected?: () => void;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const anyConnected =
    Boolean(sourceControlSetup.connectedProvider) ||
    sourceControlSetup.providers.some((provider) => provider.connected);

  return (
    <>
      <div className="hidden h-full shrink-0 lg:block">
        <SetupSourceControlPanel
          sourceControlSetup={sourceControlSetup}
          onConnected={onConnected}
        />
      </div>
      <div className="lg:hidden">
        <Drawer open={sheetOpen} onOpenChange={setSheetOpen}>
          <DrawerTrigger asChild>
            <Button variant="outline" size="sm" className="w-full">
              {anyConnected
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
                compact
              />
            </div>
          </DrawerContent>
        </Drawer>
      </div>
    </>
  );
}

export function useSetupSourceControlStatus(enabled: boolean) {
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
      sourceControlSetup?.providers.filter((provider) => provider.connected)
        .length ?? 0,
    [sourceControlSetup],
  );
  return { statusQuery, sourceControlSetup, connectedProviderCount };
}

export function useSetupSourceControlMilestoneEffect({
  enabled,
  connectedProviderCount,
}: {
  enabled: boolean;
  connectedProviderCount: number;
}) {
  const trpc = useTRPC();
  const milestoneRecorded = useMutation(
    trpc.setup.sessionMilestone.mutationOptions(),
  );

  // OAuth callback query parameters are treated only as refresh hints. The
  // authoritative signal is the connected provider state from the server,
  // and the server records the milestone exactly once.
  useEffect(() => {
    if (!enabled || connectedProviderCount === 0) return;
    milestoneRecorded.mutate({
      milestone: 'source_control_connected',
      eventType: 'source_control_connected',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, connectedProviderCount]);
}

export function useSetupRouteTransition({
  sessionId,
  completed,
}: {
  sessionId: string | null;
  completed: boolean;
}) {
  const router = useRouter();
  useEffect(() => {
    if (sessionId && completed) {
      router.replace(`/sessions/${sessionId}`);
    }
  }, [sessionId, completed, router]);
}
