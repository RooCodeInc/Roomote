'use client';

import type {
  DockerProject,
  DockerProjectPort,
  EnvironmentRepositoryConfig,
  NamedPort,
} from '@roomote/types';

import {
  Button,
  Checkbox,
  Input,
  Label,
  Plus,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Trash2,
} from '@/components/system';

import { FieldShell } from './VisualEnvironmentEditor.layout';

function splitList(value: string): string[] | undefined {
  const values = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

export function DockerProjectListEditor({
  projects,
  repositories,
  ports,
  onChange,
}: {
  projects?: DockerProject[];
  repositories: EnvironmentRepositoryConfig[];
  ports?: NamedPort[];
  onChange: (projects: DockerProject[] | undefined) => void;
}) {
  const updateProject = (index: number, project: DockerProject) => {
    const next = [...(projects ?? [])];
    next[index] = project;
    onChange(next);
  };

  return (
    <div className="space-y-4">
      {(projects ?? []).map((project, index) => (
        <div
          key={`${project.name}-${index}`}
          className="space-y-4 rounded-lg border border-border/70 bg-background/60 p-4"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">
              {project.name || `Docker project ${index + 1}`}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove Docker project ${index + 1}`}
              onClick={() => {
                const next = (projects ?? []).filter(
                  (_, projectIndex) => projectIndex !== index,
                );
                onChange(next.length > 0 ? next : undefined);
              }}
            >
              <Trash2 />
            </Button>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <FieldShell>
              <Label htmlFor={`docker-project-name-${index}`}>Name</Label>
              <Input
                id={`docker-project-name-${index}`}
                value={project.name}
                placeholder="app"
                onChange={(event) =>
                  updateProject(index, {
                    ...project,
                    name: event.target.value,
                  })
                }
              />
            </FieldShell>

            <FieldShell>
              <Label>Source</Label>
              <Select
                value={project.type}
                onValueChange={(type) => {
                  const common = {
                    name: project.name,
                    repository: project.repository,
                    ...(project.working_dir
                      ? { working_dir: project.working_dir }
                      : {}),
                    ...(project.env ? { env: project.env } : {}),
                    ...(project.ports ? { ports: project.ports } : {}),
                    ...(project.required !== undefined
                      ? { required: project.required }
                      : {}),
                    ...(project.startup_timeout_seconds
                      ? {
                          startup_timeout_seconds:
                            project.startup_timeout_seconds,
                        }
                      : {}),
                  };
                  updateProject(
                    index,
                    type === 'compose'
                      ? { ...common, type: 'compose', files: ['compose.yaml'] }
                      : { ...common, type: 'dockerfile' },
                  );
                }}
              >
                <SelectTrigger aria-label="Container source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="compose">Docker Compose</SelectItem>
                  <SelectItem value="dockerfile">Dockerfile</SelectItem>
                </SelectContent>
              </Select>
            </FieldShell>

            <FieldShell>
              <Label>Repository</Label>
              <Select
                value={project.repository}
                onValueChange={(repository) =>
                  updateProject(index, { ...project, repository })
                }
              >
                <SelectTrigger aria-label="Docker project repository">
                  <SelectValue placeholder="Select repository" />
                </SelectTrigger>
                <SelectContent>
                  {repositories
                    .filter((repository) => repository.repository)
                    .map((repository) => (
                      <SelectItem
                        key={repository.repository}
                        value={repository.repository}
                      >
                        {repository.repository}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </FieldShell>

            <FieldShell>
              <Label htmlFor={`docker-project-working-dir-${index}`}>
                Working directory
              </Label>
              <Input
                id={`docker-project-working-dir-${index}`}
                value={project.working_dir ?? ''}
                placeholder="."
                onChange={(event) => {
                  const workingDir = event.target.value.trim();
                  const next = { ...project };
                  if (workingDir) next.working_dir = workingDir;
                  else delete next.working_dir;
                  updateProject(index, next);
                }}
              />
            </FieldShell>

            {project.type === 'compose' ? (
              <>
                <FieldShell>
                  <Label htmlFor={`docker-project-files-${index}`}>
                    Compose files
                  </Label>
                  <Input
                    id={`docker-project-files-${index}`}
                    value={project.files.join(', ')}
                    placeholder="compose.yaml"
                    onChange={(event) =>
                      updateProject(index, {
                        ...project,
                        files: splitList(event.target.value) ?? [],
                      })
                    }
                  />
                </FieldShell>
                <FieldShell>
                  <Label htmlFor={`docker-project-services-${index}`}>
                    Services (optional)
                  </Label>
                  <Input
                    id={`docker-project-services-${index}`}
                    value={project.services?.join(', ') ?? ''}
                    placeholder="web, api"
                    onChange={(event) => {
                      const services = splitList(event.target.value);
                      const next = { ...project };
                      if (services) next.services = services;
                      else delete next.services;
                      updateProject(index, next);
                    }}
                  />
                </FieldShell>
                <FieldShell>
                  <Label htmlFor={`docker-project-profiles-${index}`}>
                    Profiles (optional)
                  </Label>
                  <Input
                    id={`docker-project-profiles-${index}`}
                    value={project.profiles?.join(', ') ?? ''}
                    placeholder="development"
                    onChange={(event) => {
                      const profiles = splitList(event.target.value);
                      const next = { ...project };
                      if (profiles) next.profiles = profiles;
                      else delete next.profiles;
                      updateProject(index, next);
                    }}
                  />
                </FieldShell>
              </>
            ) : (
              <>
                <FieldShell>
                  <Label htmlFor={`docker-project-context-${index}`}>
                    Build context
                  </Label>
                  <Input
                    id={`docker-project-context-${index}`}
                    value={project.context ?? ''}
                    placeholder="."
                    onChange={(event) => {
                      const context = event.target.value.trim();
                      const next = { ...project };
                      if (context) next.context = context;
                      else delete next.context;
                      updateProject(index, next);
                    }}
                  />
                </FieldShell>
                <FieldShell>
                  <Label htmlFor={`docker-project-dockerfile-${index}`}>
                    Dockerfile path
                  </Label>
                  <Input
                    id={`docker-project-dockerfile-${index}`}
                    value={project.dockerfile ?? ''}
                    placeholder="Dockerfile"
                    onChange={(event) => {
                      const dockerfile = event.target.value.trim();
                      const next = { ...project };
                      if (dockerfile) next.dockerfile = dockerfile;
                      else delete next.dockerfile;
                      updateProject(index, next);
                    }}
                  />
                </FieldShell>
                <FieldShell>
                  <Label htmlFor={`docker-project-target-${index}`}>
                    Build target (optional)
                  </Label>
                  <Input
                    id={`docker-project-target-${index}`}
                    value={project.target ?? ''}
                    onChange={(event) => {
                      const target = event.target.value.trim();
                      const next = { ...project };
                      if (target) next.target = target;
                      else delete next.target;
                      updateProject(index, next);
                    }}
                  />
                </FieldShell>
              </>
            )}
          </div>

          <ContainerPortMappings
            project={project}
            ports={ports}
            onChange={(projectPorts) => {
              const next = { ...project };
              if (projectPorts.length > 0) next.ports = projectPorts;
              else delete next.ports;
              updateProject(index, next);
            }}
          />

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={project.required !== false}
              onCheckedChange={(checked) =>
                updateProject(index, {
                  ...project,
                  required: checked === true,
                })
              }
            />
            Fail environment startup if this project cannot start
          </label>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!repositories.some((repository) => repository.repository)}
        onClick={() => {
          const repository =
            repositories.find((candidate) => candidate.repository)
              ?.repository ?? '';
          onChange([
            ...(projects ?? []),
            {
              type: 'compose',
              name: `app${(projects?.length ?? 0) + 1}`,
              repository,
              files: ['compose.yaml'],
              required: true,
            },
          ]);
        }}
      >
        <Plus />
        Add Docker project
      </Button>
    </div>
  );
}

function ContainerPortMappings({
  project,
  ports,
  onChange,
}: {
  project: DockerProject;
  ports?: NamedPort[];
  onChange: (ports: DockerProjectPort[]) => void;
}) {
  const mappings = project.ports ?? [];
  return (
    <div className="space-y-2">
      <Label>Preview port mappings</Label>
      {mappings.map((mapping, index) => (
        <div
          key={`${mapping.named_port}-${index}`}
          className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]"
        >
          <Select
            value={mapping.named_port}
            onValueChange={(namedPort) =>
              onChange(
                mappings.map((current, currentIndex) =>
                  currentIndex === index
                    ? { ...current, named_port: namedPort }
                    : current,
                ),
              )
            }
          >
            <SelectTrigger aria-label="Environment port">
              <SelectValue placeholder="Environment port" />
            </SelectTrigger>
            <SelectContent>
              {(ports ?? []).map((port) => (
                <SelectItem key={port.name} value={port.name}>
                  {port.name} ({port.port})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {project.type === 'compose' ? (
            <Input
              aria-label="Compose service"
              value={mapping.service ?? ''}
              placeholder="Compose service"
              onChange={(event) =>
                onChange(
                  mappings.map((current, currentIndex) =>
                    currentIndex === index
                      ? { ...current, service: event.target.value }
                      : current,
                  ),
                )
              }
            />
          ) : (
            <div />
          )}
          <Input
            aria-label="Container port"
            type="number"
            min={1}
            max={65535}
            value={mapping.container_port}
            placeholder="3000"
            onChange={(event) =>
              onChange(
                mappings.map((current, currentIndex) =>
                  currentIndex === index
                    ? {
                        ...current,
                        container_port: Number(event.target.value),
                      }
                    : current,
                ),
              )
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove port mapping ${index + 1}`}
            onClick={() =>
              onChange(
                mappings.filter((_, mappingIndex) => mappingIndex !== index),
              )
            }
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!ports?.length}
        onClick={() => {
          const firstPort = ports?.[0];
          if (!firstPort) return;
          onChange([
            ...mappings,
            {
              named_port: firstPort.name,
              ...(project.type === 'compose' ? { service: '' } : {}),
              container_port: firstPort.port,
            },
          ]);
        }}
      >
        <Plus />
        Map preview port
      </Button>
    </div>
  );
}
