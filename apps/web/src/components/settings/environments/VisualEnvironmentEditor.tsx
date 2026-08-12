'use client';

import { useEffect, useRef } from 'react';

import {
  type EnvironmentConfig,
  type ServiceConfig,
  type ServiceName,
} from '@roomote/types';

import {
  Button,
  Checkbox,
  Container,
  Database,
  GitBranch,
  Globe,
  InfoTooltip,
  Input,
  KeyRound,
  Label,
  MessageSquareText,
  Plus,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Settings2,
  Textarea,
  Wrench,
} from '@/components/system';

import { KeyValueListEditor } from './KeyValueListEditor';
import { DockerProjectListEditor } from './DockerProjectListEditor';
import { PortListEditor } from './PortListEditor';
import { RepositoryEditor } from './RepositoryEditor';
import { RoutingRulesEditor } from './RoutingRulesEditor';
import { FieldShell, SectionShell } from './VisualEnvironmentEditor.layout';
import {
  getServiceName,
  getServiceVersionLabel,
  hasBasicContent,
  hasRecordEntries,
  hasRepositoryContent,
  SERVICE_GROUPS,
  SORTED_SERVICE_GROUPS,
  trimToUndefined,
  optionalTextToUndefined,
  updateEnvironmentConfig,
  type RepositoryOption,
} from './VisualEnvironmentEditor.model';

interface VisualEnvironmentEditorProps {
  config: EnvironmentConfig;
  onChange: (config: EnvironmentConfig) => void;
  repositories?: RepositoryOption[];
  showLivePreviewSettings?: boolean;
}

export function VisualEnvironmentEditor({
  config,
  onChange,
  repositories = [],
  showLivePreviewSettings = true,
}: VisualEnvironmentEditorProps) {
  const lastServiceByGroupRef = useRef<Partial<Record<string, ServiceConfig>>>(
    {},
  );

  useEffect(() => {
    for (const service of config.services ?? []) {
      const serviceName = getServiceName(service);
      const serviceGroup = SERVICE_GROUPS.find((group) =>
        group.services.includes(serviceName),
      );

      if (serviceGroup) {
        lastServiceByGroupRef.current[serviceGroup.id] = service;
      }
    }
  }, [config.services]);

  return (
    <div className="space-y-8 pt-4">
      <SectionShell
        icon={Settings2}
        title="Basics"
        defaultOpen={hasBasicContent(config)}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <FieldShell>
            <Label htmlFor="visual-environment-name">Name</Label>
            <Input
              id="visual-environment-name"
              value={config.name}
              onChange={(event) =>
                onChange(
                  updateEnvironmentConfig(config, (draft) => {
                    draft.name = event.target.value;
                  }),
                )
              }
            />
          </FieldShell>

          <FieldShell>
            <div className="flex items-center gap-1.5">
              <Label htmlFor="visual-environment-initial-url">
                Initial URL
              </Label>
              <InfoTooltip content="The URL agents and previews should open first after the environment starts. Leave blank to use about:blank." />
            </div>
            <Input
              id="visual-environment-initial-url"
              value={config.initialUrl ?? ''}
              placeholder="about:blank"
              onChange={(event) =>
                onChange(
                  updateEnvironmentConfig(config, (draft) => {
                    const nextValue = trimToUndefined(event.target.value);
                    if (nextValue) {
                      draft.initialUrl = nextValue;
                    } else {
                      delete draft.initialUrl;
                    }
                  }),
                )
              }
            />
          </FieldShell>

          <FieldShell className="md:col-span-2">
            <div className="flex items-center gap-1.5">
              <Label htmlFor="visual-environment-description">
                Description
              </Label>
              <InfoTooltip content="A short human-readable summary of what this environment is for. It helps distinguish similar environments in settings and agent flows." />
            </div>
            <Textarea
              id="visual-environment-description"
              value={config.description ?? ''}
              className="min-h-24 resize-y"
              onChange={(event) =>
                onChange(
                  updateEnvironmentConfig(config, (draft) => {
                    const nextValue = optionalTextToUndefined(
                      event.target.value,
                    );
                    if (nextValue) {
                      draft.description = nextValue;
                    } else {
                      delete draft.description;
                    }
                  }),
                )
              }
            />
          </FieldShell>
        </div>
      </SectionShell>

      <SectionShell
        icon={Database}
        title="Services"
        defaultOpen={Boolean(config.services?.length)}
      >
        <p className="mb-4 text-sm text-muted-foreground">
          Add managed services that should be available before repository setup
          commands run.
        </p>
        <div className="w-full max-w-64 space-y-3">
          {SORTED_SERVICE_GROUPS.map((serviceGroup) => {
            const selectedService = (config.services ?? []).find((service) =>
              serviceGroup.services.includes(getServiceName(service)),
            );
            const selectedServiceName = selectedService
              ? getServiceName(selectedService)
              : serviceGroup.services.at(-1)!;
            const hasMultipleVersions = serviceGroup.services.length > 1;

            return (
              <div
                key={serviceGroup.id}
                className="flex min-h-8 w-full items-center justify-between gap-2"
              >
                <label
                  htmlFor={`visual-environment-service-${serviceGroup.id}`}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <Checkbox
                    id={`visual-environment-service-${serviceGroup.id}`}
                    checked={Boolean(selectedService)}
                    onCheckedChange={(checked) =>
                      onChange(
                        updateEnvironmentConfig(config, (draft) => {
                          const currentServices = [...(draft.services ?? [])];
                          const currentIndex = currentServices.findIndex(
                            (service) =>
                              serviceGroup.services.includes(
                                getServiceName(service),
                              ),
                          );

                          if (checked === true) {
                            if (currentIndex < 0) {
                              currentServices.push(
                                lastServiceByGroupRef.current[
                                  serviceGroup.id
                                ] ?? selectedServiceName,
                              );
                            }
                          } else if (currentIndex >= 0) {
                            lastServiceByGroupRef.current[serviceGroup.id] =
                              currentServices[currentIndex];
                            currentServices.splice(currentIndex, 1);
                          }

                          if (currentServices.length > 0) {
                            draft.services = currentServices;
                          } else {
                            delete draft.services;
                          }
                        }),
                      )
                    }
                  />
                  <span>{serviceGroup.label}</span>
                </label>

                {hasMultipleVersions && Boolean(selectedService) ? (
                  <Select
                    value={selectedServiceName}
                    disabled={!selectedService}
                    onValueChange={(nextServiceName) =>
                      onChange(
                        updateEnvironmentConfig(config, (draft) => {
                          const serviceName = nextServiceName as ServiceName;
                          const currentServices = [...(draft.services ?? [])];
                          const currentIndex = currentServices.findIndex(
                            (service) =>
                              serviceGroup.services.includes(
                                getServiceName(service),
                              ),
                          );

                          if (currentIndex >= 0) {
                            const currentService =
                              currentServices[currentIndex];
                            currentServices[currentIndex] =
                              typeof currentService === 'string'
                                ? serviceName
                                : { ...currentService, name: serviceName };
                          } else {
                            currentServices.push(serviceName);
                          }

                          draft.services = currentServices;
                        }),
                      )
                    }
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label={`${serviceGroup.label} version`}
                    >
                      Version <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {serviceGroup.services.map((serviceName) => (
                        <SelectItem key={serviceName} value={serviceName}>
                          {getServiceVersionLabel(serviceGroup, serviceName)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </div>
            );
          })}
        </div>
      </SectionShell>

      <SectionShell
        icon={GitBranch}
        title="Repositories"
        defaultOpen={config.repositories.some(hasRepositoryContent)}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              onChange(
                updateEnvironmentConfig(config, (draft) => {
                  draft.repositories = [
                    ...draft.repositories,
                    { repository: '', commands: [] },
                  ];
                }),
              )
            }
          >
            <Plus />
            Add Repo
          </Button>
        }
      >
        <p className="mb-4 text-sm text-muted-foreground">
          Choose the repositories to clone for this environment, then configure
          repo-specific setup details.
        </p>
        <div className="space-y-3">
          {config.repositories.map((repository, index) => (
            <RepositoryEditor
              key={`${repository.repository}-${index}`}
              repository={repository}
              removable={config.repositories.length > 1}
              fieldId={`visual-repository-${index}`}
              repositoryOptions={repositories}
              onChange={(nextRepository) =>
                onChange(
                  updateEnvironmentConfig(config, (draft) => {
                    draft.repositories[index] = nextRepository;
                  }),
                )
              }
              onRemove={() =>
                onChange(
                  updateEnvironmentConfig(config, (draft) => {
                    draft.repositories = draft.repositories.filter(
                      (_, repositoryIndex) => repositoryIndex !== index,
                    );
                  }),
                )
              }
            />
          ))}
        </div>
      </SectionShell>

      <SectionShell
        icon={Container}
        title="Docker Compose & Dockerfile"
        defaultOpen={Boolean(config.docker_projects?.length)}
      >
        <p className="mb-4 text-sm text-muted-foreground">
          Build and start an existing Docker Compose project or Dockerfile after
          its repository is ready. Projects run inside this task&apos;s isolated
          environment.
        </p>
        <DockerProjectListEditor
          projects={config.docker_projects}
          repositories={config.repositories}
          ports={config.ports}
          onChange={(next) =>
            onChange(
              updateEnvironmentConfig(config, (draft) => {
                if (next) draft.docker_projects = next;
                else delete draft.docker_projects;
              }),
            )
          }
        />
      </SectionShell>

      <SectionShell
        icon={KeyRound}
        title="Environment Variables"
        defaultOpen={hasRecordEntries(config.env)}
      >
        <p className="mb-4 text-sm text-muted-foreground">
          Environment variables are injected into tasks launched with this
          environment. Values can be literal, or can reference encrypted
          deployment-level variables with{' '}
          <code className="font-mono">${'{KEY}'}</code> or{' '}
          <code className="font-mono">$KEY</code>.
        </p>
        <KeyValueListEditor
          value={config.env}
          allowEmptyValues
          enableFocusResize
          defaultRowWidth="100%"
          focusedRowWidth="100%"
          onChange={(next) =>
            onChange(
              updateEnvironmentConfig(config, (draft) => {
                if (next) {
                  draft.env = next;
                } else {
                  delete draft.env;
                }
              }),
            )
          }
          keyLabel="Key"
          valueLabel="Value"
          emptyLabel="No environment variables"
          addLabel="Add environment variable"
        />
      </SectionShell>

      <SectionShell
        icon={Wrench}
        title="Environment .tool-versions"
        defaultOpen={hasRecordEntries(config.tool_versions)}
      >
        <p className="mb-4 text-sm text-muted-foreground">
          Writes a shared .tool-versions file at the workspace root and runs
          mise install there. Use this for workspace-root commands and as a
          fallback when a repo does not already pin a tool locally.
        </p>
        <KeyValueListEditor
          value={config.tool_versions}
          onChange={(next) =>
            onChange(
              updateEnvironmentConfig(config, (draft) => {
                if (next) {
                  draft.tool_versions = next;
                } else {
                  delete draft.tool_versions;
                }
              }),
            )
          }
          keyLabel="Tool"
          valueLabel="Version"
          emptyLabel="No tool versions"
          addLabel="Add tool"
          inputClassName="font-mono"
        />
      </SectionShell>

      {showLivePreviewSettings ? (
        <SectionShell
          icon={Globe}
          title="Exposed Ports"
          defaultOpen={Boolean(config.ports?.length)}
        >
          <p className="mb-4 text-sm text-muted-foreground">
            Exposed ports are optional, but highly recommended. Agents use them
            for direct live previews of running services.
          </p>
          <PortListEditor
            ports={config.ports}
            onChange={(next) =>
              onChange(
                updateEnvironmentConfig(config, (draft) => {
                  if (next) {
                    draft.ports = next;
                  } else {
                    delete draft.ports;
                  }
                }),
              )
            }
          />
        </SectionShell>
      ) : null}

      <SectionShell
        icon={GitBranch}
        title="Routing Rules"
        defaultOpen={Boolean(config.routingRules?.length)}
      >
        <p className="mb-4 text-sm text-muted-foreground">
          Tell the router when tasks belong in this environment. Specific rules
          take precedence over catch-all defaults.
        </p>
        <RoutingRulesEditor
          rules={config.routingRules ?? []}
          onChange={(rules) =>
            onChange(
              updateEnvironmentConfig(config, (draft) => {
                const normalized = rules.map((rule) => rule.slice(0, 500));
                if (normalized.length > 0) draft.routingRules = normalized;
                else delete draft.routingRules;
              }),
            )
          }
        />
      </SectionShell>

      <SectionShell
        icon={MessageSquareText}
        title="Agent Instructions"
        defaultOpen={Boolean(trimToUndefined(config.agentInstructions ?? ''))}
      >
        <p className="mb-4 text-sm text-muted-foreground">
          Add environment-specific guidance that agents should follow whenever
          they work in this environment.
        </p>
        <Textarea
          value={config.agentInstructions ?? ''}
          className="min-h-32 resize-y"
          onChange={(event) =>
            onChange(
              updateEnvironmentConfig(config, (draft) => {
                const nextValue = optionalTextToUndefined(event.target.value);
                if (nextValue) {
                  draft.agentInstructions = nextValue;
                } else {
                  delete draft.agentInstructions;
                }
              }),
            )
          }
        />
      </SectionShell>
    </div>
  );
}
