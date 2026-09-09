'use client';

import { useState, type ReactNode } from 'react';
import {
  getTriggerableBackgroundAutomationDescriptorByKey,
  type CiFailureTriageRepositoryRoute,
  type CommunicationProvider,
} from '@roomote/types';

import { useRepositories } from '@/hooks/source-control';
import {
  Button,
  Label,
  Plus,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Trash2,
} from '@/components/system';

import { EnvironmentRepositorySelector } from '../environments/EnvironmentRepositorySelector';
import {
  AutomationDestinationPicker,
  PROVIDER_LABELS,
} from './AutomationDestinationPicker';

type Props = {
  routes: CiFailureTriageRepositoryRoute[] | undefined;
  onChange: (routes: CiFailureTriageRepositoryRoute[] | undefined) => void;
  availableProviders: readonly CommunicationProvider[];
  slackOptions: { id: string; name: string; label: string }[];
  discordOptions: { id: string; name: string; label: string }[];
  globalDestination: ReactNode;
  error?: string;
};

export function CiFailureTriageRepositoryRoutesEditor(props: Props) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="ci-repository-scope">Repository scope</Label>
        <Select
          value={props.routes === undefined ? 'all' : 'selected'}
          onValueChange={(value) =>
            props.onChange(value === 'all' ? undefined : [])
          }
        >
          <SelectTrigger id="ci-repository-scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All repositories</SelectItem>
            <SelectItem value="selected">Selected repository groups</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {props.routes === undefined ? (
        props.globalDestination
      ) : (
        <SelectedRoutes {...props} routes={props.routes} />
      )}
      {props.error ? (
        <p role="alert" className="text-sm text-destructive">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

function SelectedRoutes({
  routes,
  onChange,
  availableProviders,
  slackOptions,
  discordOptions,
}: Props & { routes: CiFailureTriageRepositoryRoute[] }) {
  const [editing, setEditing] = useState<number[]>(() =>
    routes.flatMap((route, index) =>
      route.repositoryIds.length === 0 || !route.target.externalRef.trim()
        ? [index]
        : [],
    ),
  );
  const repositories = useRepositories();
  const supported =
    getTriggerableBackgroundAutomationDescriptorByKey(
      'ci_failure_triage',
    )!.supportedSourceControlProviders;
  const options = (repositories.data ?? [])
    .filter((repo) =>
      supported.some((provider) => provider === repo.sourceControlProvider),
    )
    .map((repo) => ({
      id: repo.id,
      fullName: `${repo.fullName} (${repo.sourceControlProvider}${repo.host ? ` | ${repo.host}` : ''})`,
    }));
  const updateRoute = (index: number, route: CiFailureTriageRepositoryRoute) =>
    onChange(
      routes.map((entry, position) => (position === index ? route : entry)),
    );
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Only selected repositories are monitored. Each repository can have one
        report destination.
      </p>
      {repositories.isPending ? <Skeleton className="h-20 w-full" /> : null}
      {repositories.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Unable to load repositories.
        </p>
      ) : null}
      {routes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No repositories selected. CI Failure Triage will not launch tasks.
        </p>
      ) : null}
      {routes.map((route, index) => {
        const usedElsewhere = new Set(
          routes.flatMap((entry, position) =>
            position === index ? [] : entry.repositoryIds,
          ),
        );
        const routeOptions = options.filter(
          (option) => !usedElsewhere.has(option.id),
        );
        for (const id of route.repositoryIds) {
          if (!routeOptions.some((option) => option.id === id))
            routeOptions.push({
              id,
              fullName: `Unavailable repository (${id})`,
            });
        }
        const destinationOptions =
          route.target.provider === 'discord' &&
          route.target.externalRef &&
          !discordOptions.some(
            (option) => option.id === route.target.externalRef,
          )
            ? [
                ...discordOptions,
                {
                  id: route.target.externalRef,
                  name: route.target.externalRef,
                  label: route.target.externalRef,
                },
              ]
            : discordOptions;
        const complete =
          route.repositoryIds.length > 0 &&
          Boolean(route.target.externalRef.trim());
        const isEditing = editing.includes(index) || !complete;
        const repositoryNames = route.repositoryIds
          .map(
            (id) =>
              routeOptions.find((option) => option.id === id)?.fullName ??
              `Unavailable repository (${id})`,
          )
          .join(', ');
        const destinationLabel = (
          route.target.provider === 'slack'
            ? slackOptions
            : route.target.provider === 'discord'
              ? discordOptions
              : []
        ).find((option) => option.id === route.target.externalRef)?.label;
        return (
          <fieldset
            key={index}
            aria-label={`Repository destination ${index + 1}`}
            className={
              isEditing
                ? 'min-w-0 space-y-3'
                : 'flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'
            }
          >
            {isEditing ? (
              <>
                <div
                  role="group"
                  aria-labelledby={`ci-route-${index}-repositories`}
                  className="space-y-2"
                >
                  <Label id={`ci-route-${index}-repositories`}>
                    Repositories
                  </Label>
                  <EnvironmentRepositorySelector
                    repositories={routeOptions}
                    selectedRepositoryIds={route.repositoryIds}
                    inputPrefix={`ci-route-${index}`}
                    heightClassName="max-h-48"
                    onToggleRepository={(id) =>
                      updateRoute(index, {
                        ...route,
                        repositoryIds: route.repositoryIds.includes(id)
                          ? route.repositoryIds.filter(
                              (existing) => existing !== id,
                            )
                          : [...route.repositoryIds, id],
                      })
                    }
                  />
                </div>
                <AutomationDestinationPicker
                  id={`ci-route-${index}-destination`}
                  label="Send reports to"
                  value={{
                    provider: route.target.provider,
                    mode: 'channel',
                    channelId: route.target.externalRef,
                  }}
                  availableProviders={availableProviders}
                  slackOptions={slackOptions}
                  discordOptions={destinationOptions}
                  allowNone={false}
                  allowDirectMessage={false}
                  onChange={(destination) => {
                    if (destination.provider === 'none') return;
                    updateRoute(index, {
                      ...route,
                      target: {
                        provider: destination.provider,
                        targetKind:
                          destination.provider === 'telegram'
                            ? 'telegram_chat'
                            : `${destination.provider}_channel`,
                        externalRef: destination.channelId,
                      },
                    });
                  }}
                />
              </>
            ) : (
              <p className="min-w-0 break-words text-sm">
                <span className="font-medium">{repositoryNames}</span>
                {' → '}
                <span className="text-muted-foreground">
                  {destinationLabel ??
                    `${PROVIDER_LABELS[route.target.provider]} · ${route.target.externalRef}`}
                </span>
              </p>
            )}
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isEditing && !complete}
                aria-expanded={isEditing}
                onClick={() =>
                  setEditing((current) =>
                    isEditing
                      ? current.filter((position) => position !== index)
                      : [...current, index],
                  )
                }
              >
                {isEditing ? 'Done' : 'Edit'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing((current) =>
                    current
                      .filter((position) => position !== index)
                      .map((position) =>
                        position > index ? position - 1 : position,
                      ),
                  );
                  onChange(routes.filter((_, position) => position !== index));
                }}
              >
                <Trash2 />
                Remove
              </Button>
            </div>
          </fieldset>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          const provider = availableProviders[0] ?? 'slack';
          setEditing((current) => [...current, routes.length]);
          onChange([
            ...routes,
            {
              repositoryIds: [],
              target: {
                provider,
                targetKind:
                  provider === 'telegram'
                    ? 'telegram_chat'
                    : `${provider}_channel`,
                externalRef: '',
              },
            },
          ]);
        }}
      >
        <Plus />
        Add repository destination
      </Button>
    </div>
  );
}
