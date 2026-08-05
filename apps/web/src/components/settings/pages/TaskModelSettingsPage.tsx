'use client';

import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';

import { InferenceProviderSection } from '@/components/settings/InferenceProviderSection';
import { ModelSettingsSection } from '@/components/settings/ModelSettingsSection';
import { SettingsShell } from '@/components/settings/SettingsShell';
import { splitInferenceProviders } from '@/components/settings/taskModelProviderSetup';
import { HeaderCallout, Medal } from '@/components/system';
import { useTRPC } from '@/trpc/client';

const MODEL_RECOMMENDATIONS_URL = 'https://roomote.dev/evals';

export function TaskModelSettingsPage() {
  const trpc = useTRPC();
  const providerSetupQuery = useQuery(
    trpc.taskModels.providerSetup.queryOptions(),
  );
  const providerSetup = providerSetupQuery.data?.providerSetup ?? null;
  const { connectedProviders, availableProviders } =
    splitInferenceProviders(providerSetup);
  const modelSectionRef = useRef<HTMLDivElement | null>(null);
  const recommendationsCallout = (
    <HeaderCallout
      icon={Medal}
      text="Need help picking the best model?"
      action={MODEL_RECOMMENDATIONS_URL}
      buttonLabel="View Recs"
    />
  );

  return (
    <SettingsShell
      pageId="models"
      adminOnly={true}
      headerAction={recommendationsCallout}
    >
      <div className="space-y-6">
        <div className="md:hidden">{recommendationsCallout}</div>
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
