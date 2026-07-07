'use client';

import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';

import { InferenceProviderSection } from '@/components/settings/InferenceProviderSection';
import { ModelSettingsSection } from '@/components/settings/ModelSettingsSection';
import { SettingsShell } from '@/components/settings/SettingsShell';
import { splitInferenceProviders } from '@/components/settings/taskModelProviderSetup';
import { useTRPC } from '@/trpc/client';

export function TaskModelSettingsPage() {
  const trpc = useTRPC();
  const providerSetupQuery = useQuery(
    trpc.taskModels.providerSetup.queryOptions(),
  );
  const providerSetup = providerSetupQuery.data?.providerSetup ?? null;
  const { connectedProviders, availableProviders } =
    splitInferenceProviders(providerSetup);
  const modelSectionRef = useRef<HTMLDivElement | null>(null);

  return (
    <SettingsShell pageId="models" adminOnly={true}>
      <div className="space-y-6">
        <InferenceProviderSection
          providerSetup={providerSetup}
          providerSetupPending={providerSetupQuery.isPending}
          connectedProviders={connectedProviders}
          availableProviders={availableProviders}
          onRecommendedModelsAdded={() =>
            modelSectionRef.current?.scrollIntoView({
              behavior: 'smooth',
              block: 'start',
            })
          }
        />
        <div ref={modelSectionRef} className="scroll-mt-6">
          <ModelSettingsSection
            connectedProviders={connectedProviders}
            providerSetupPending={providerSetupQuery.isPending}
          />
        </div>
      </div>
    </SettingsShell>
  );
}
