'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BookMarked, GitBranch } from '@/components/system';
import { Badge, Button, Skeleton } from '@/components/system';
import { Section } from '@/components/settings';
import { SETTINGS_PATHS } from '@/lib/settings';
import {
  useEnvironments,
  useUpdateWorkspaceRoutingSettings,
  useWorkspaceRoutingSettings,
} from '@/hooks/environments';
import { useRepositories } from '@/hooks/source-control';

import { RoutingRulesEditor } from './RoutingRulesEditor';

export function EnvironmentRoutingOverview() {
  const repositories = useRepositories();
  const environments = useEnvironments();
  const settings = useWorkspaceRoutingSettings();
  const updateSettings = useUpdateWorkspaceRoutingSettings();
  const [allRepositoryRules, setAllRepositoryRules] = useState<string[]>([]);

  useEffect(() => {
    setAllRepositoryRules(settings.data?.allRepositoriesRoutingRules ?? []);
  }, [settings.data]);

  if (repositories.isPending || environments.isPending || settings.isPending) {
    return (
      <Section icon={GitBranch} title="Workspace routing">
        <Skeleton className="h-24 w-full" />
      </Section>
    );
  }

  const environmentList = environments.data ?? [];

  return (
    <Section icon={GitBranch} title="Workspace routing">
      <div className="space-y-3">
        <div>
          <p className="text-sm font-medium">All repositories rules</p>
          <p className="mb-3 text-sm text-muted-foreground">
            Route matching requests to the broad workspace containing every
            connected repository.
          </p>
          <RoutingRulesEditor
            rules={allRepositoryRules}
            onChange={setAllRepositoryRules}
          />
          <Button
            type="button"
            className="mt-3"
            size="sm"
            disabled={
              updateSettings.isPending ||
              allRepositoryRules.some((rule) => !rule.trim())
            }
            onClick={async () => {
              try {
                await updateSettings.mutateAsync({
                  allRepositoriesRoutingRules: allRepositoryRules,
                });
                toast.success('Routing rules updated');
              } catch {
                toast.error('Failed to update routing rules');
              }
            }}
          >
            Save rules
          </Button>
        </div>

        <div className="border-t border-border pt-4">
          <p className="text-sm font-medium">Repository coverage</p>
          <p className="mb-3 text-sm text-muted-foreground">
            Every connected repository and the environments that include it.
          </p>
          <div className="divide-y divide-border">
            {(repositories.data ?? []).map((repository) => {
              const mappedEnvironments = environmentList.filter((environment) =>
                environment.config.repositories.some(
                  (configured) =>
                    configured.repository.toLowerCase() ===
                    repository.fullName.toLowerCase(),
                ),
              );

              return (
                <div
                  key={repository.id}
                  className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-center gap-2 text-sm">
                    <BookMarked className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate ph-no-capture">
                      {repository.fullName}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {mappedEnvironments.length > 0 ? (
                      mappedEnvironments.map((environment) => (
                        <Badge key={environment.id} variant="outline" asChild>
                          <Link
                            href={SETTINGS_PATHS.editEnvironment(
                              environment.id,
                            )}
                          >
                            {environment.name}
                          </Link>
                        </Badge>
                      ))
                    ) : (
                      <>
                        <Badge variant="secondary">No environment</Badge>
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={SETTINGS_PATHS.newEnvironment}>Add</Link>
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Section>
  );
}
