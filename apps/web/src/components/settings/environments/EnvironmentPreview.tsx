'use client';

import type { ComponentType, ReactNode } from 'react';

import {
  Badge,
  Database,
  GitBranch,
  Globe,
  KeyRound,
  MessageSquareText,
  Settings2,
  Square,
  SquareCheck,
  Wrench,
} from '@/components/system';

import {
  COMMAND_DEFAULT_TIMEOUT,
  type Command,
  type EnvironmentConfig,
  type EnvironmentRepositoryConfig,
  type ServiceConfig,
  type ServiceName,
} from '@roomote/types';

import { serviceLabels } from './constants';

interface EnvironmentPreviewContentProps {
  config: EnvironmentConfig;
  showLivePreviewSettings?: boolean;
}

type PreviewIcon = ComponentType<{ className?: string }>;

/**
 * Inline preview content for displaying environment configuration.
 * Used within tabs in the YAML editor.
 */
export function EnvironmentPreviewContent({
  config,
  showLivePreviewSettings = true,
}: EnvironmentPreviewContentProps) {
  const advancedItems = getAdvancedItems(config);

  return (
    <div className="space-y-8 py-4">
      {hasBasicContent(config) ? (
        <PreviewSection icon={Settings2} title="Basics">
          <div className="grid gap-3 md:grid-cols-2">
            {config.name ? (
              <PreviewField label="Name">{config.name}</PreviewField>
            ) : null}
            {config.initialUrl ? (
              <PreviewField label="Initial URL">
                <code className="font-mono text-xs">{config.initialUrl}</code>
              </PreviewField>
            ) : null}
            {config.description ? (
              <PreviewField label="Description" className="md:col-span-2">
                {config.description}
              </PreviewField>
            ) : null}
          </div>
        </PreviewSection>
      ) : null}

      {config.services && config.services.length > 0 ? (
        <PreviewSection icon={Database} title="Services">
          <div className="flex flex-wrap gap-2">
            {config.services.map((service, index) => {
              const serviceName = getServiceName(service);
              return (
                <Badge key={index} variant="secondary">
                  {serviceLabels[serviceName] || serviceName}
                </Badge>
              );
            })}
          </div>
        </PreviewSection>
      ) : null}

      <PreviewSection icon={GitBranch} title="Repositories">
        <div className="space-y-3">
          {config.repositories.map((repo, index) => (
            <RepositoryPreview
              key={`${repo.repository}-${index}`}
              repo={repo}
            />
          ))}
        </div>
      </PreviewSection>

      {hasRecordEntries(config.env) ? (
        <PreviewSection icon={KeyRound} title="Environment Variables">
          <KeyValuePreview entries={Object.entries(config.env!)} />
        </PreviewSection>
      ) : null}

      {hasRecordEntries(config.tool_versions) ? (
        <PreviewSection icon={Wrench} title="Environment .tool-versions">
          <ToolVersionPreview toolVersions={config.tool_versions!} />
        </PreviewSection>
      ) : null}

      {showLivePreviewSettings && config.ports && config.ports.length > 0 ? (
        <PreviewSection icon={Globe} title="Exposed Ports">
          <div className="space-y-2">
            {config.ports.map((port) => (
              <div
                key={`${port.name}-${port.port}`}
                className="flex flex-wrap items-center gap-2 rounded border border-border/70 px-3 py-2 text-sm"
              >
                <span className="font-medium">{port.name}</span>
                <code className="font-mono text-xs text-muted-foreground">
                  {port.port}
                </code>
                {port.initial_path ? (
                  <Badge variant="outline" className="font-mono text-xs">
                    {port.initial_path}
                  </Badge>
                ) : null}
                {port.primary ? (
                  <Badge variant="secondary">primary</Badge>
                ) : null}
                {port.unauthenticated ? (
                  <Badge variant="outline">public</Badge>
                ) : null}
              </div>
            ))}
          </div>
        </PreviewSection>
      ) : null}

      {config.agentInstructions ? (
        <PreviewSection icon={MessageSquareText} title="Agent Instructions">
          <blockquote className="whitespace-pre-wrap border-l-2 border-border ml-1.5 pl-4 text-sm text-muted-foreground">
            {config.agentInstructions}
          </blockquote>
        </PreviewSection>
      ) : null}

      {advancedItems.length > 0 ? (
        <PreviewSection icon={Settings2} title="Advanced">
          <div className="space-y-4">{advancedItems}</div>
        </PreviewSection>
      ) : null}
    </div>
  );
}

function PreviewSection({
  icon: Icon,
  title,
  children,
}: {
  icon: PreviewIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md bg-card p-4">
      <div className="mb-4 flex items-center gap-2 text-sm font-medium">
        <Icon className="size-4 text-muted-foreground" />
        <span>{title}</span>
      </div>
      {children}
    </section>
  );
}

function PreviewField({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function RepositoryPreview({ repo }: { repo: EnvironmentRepositoryConfig }) {
  return (
    <div className="space-y-5 rounded-xl border border-border/70 bg-background/70 p-5">
      <PreviewRow label="Repository">
        <code className="font-mono text-xs">
          {repo.repository}
          {repo.branch ? `@${repo.branch}` : ''}
        </code>
      </PreviewRow>

      {hasRecordEntries(repo.tool_versions) ? (
        <PreviewRow label="Repo tool fallbacks">
          <ToolVersionPreview toolVersions={repo.tool_versions!} />
        </PreviewRow>
      ) : null}

      {repo.commands && repo.commands.length > 0 ? (
        <PreviewRow label="Commands">
          <div className="divide-y divide-border/70">
            {repo.commands.map((command, index) => (
              <CommandPreview
                key={`${command.name}-${index}`}
                command={command}
              />
            ))}
          </div>
        </PreviewRow>
      ) : null}
    </div>
  );
}

function PreviewRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-[8.5rem_minmax(0,1fr)] md:gap-6">
      <div className="whitespace-nowrap text-xs text-muted-foreground md:pt-1 md:text-right">
        {label}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function CommandPreview({ command }: { command: Command }) {
  return (
    <div className="space-y-4 py-4 first:pt-0">
      <div className="grid gap-3 lg:grid-cols-[minmax(12rem,0.8fr)_minmax(18rem,1.2fr)_auto] lg:items-start">
        <PreviewField label="Command">
          <code className="font-mono text-xs text-muted-foreground">
            {command.run}
          </code>
        </PreviewField>
        <PreviewField label="Description">{command.name}</PreviewField>
        <div />
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(12rem,0.8fr)_minmax(18rem,1.2fr)_auto] lg:items-start">
        <PreviewField label="Timeout (s)">
          <code className="font-mono text-xs">
            {command.timeout ?? COMMAND_DEFAULT_TIMEOUT}
          </code>
        </PreviewField>
        <PreviewField label="Logfile path (optional)">
          {command.logfile ? (
            <code className="font-mono text-xs text-muted-foreground">
              {command.logfile}
            </code>
          ) : (
            <span className="text-muted-foreground">No log file</span>
          )}
        </PreviewField>
        <div />
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <CheckedStatus
          checked={Boolean(command.detached)}
          label="Run in the background"
        />
        <CheckedStatus
          checked={Boolean(command.continue_on_error)}
          label="Continue on error"
        />
      </div>
    </div>
  );
}

function CheckedStatus({
  checked,
  label,
}: {
  checked: boolean;
  label: string;
}) {
  const Icon = checked ? SquareCheck : Square;

  return (
    <span className="inline-flex items-center gap-2 text-muted-foreground">
      <Icon className="size-4" />
      {label}
    </span>
  );
}

function ToolVersionPreview({
  toolVersions,
}: {
  toolVersions: Record<string, string>;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {Object.entries(toolVersions).map(([tool, version]) => (
        <Badge key={tool} variant="secondary" className="font-mono text-xs">
          {tool}@{version}
        </Badge>
      ))}
    </div>
  );
}

function KeyValuePreview({ entries }: { entries: [string, string][] }) {
  return (
    <div className="space-y-1">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-center gap-2 text-sm">
          <code className="rounded bg-background px-2 py-0.5 font-mono text-xs">
            {key}
          </code>
          <span className="text-muted-foreground">=</span>
          <code className="max-w-50 truncate font-mono text-xs text-muted-foreground">
            {formatPreviewEnvValue(value)}
          </code>
        </div>
      ))}
    </div>
  );
}

function formatPreviewEnvValue(value: string) {
  if (isEnvInterpolation(value)) {
    return value;
  }

  return '•'.repeat(value.length);
}

function isEnvInterpolation(value: string) {
  return /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/.test(
    value,
  );
}

function getAdvancedItems(config: EnvironmentConfig) {
  const items: ReactNode[] = [];

  if (config.oidc) {
    items.push(
      <div key="oidc" className="space-y-2">
        <div className="text-xs text-muted-foreground">OIDC Tokens</div>
        {config.oidc.aws ? (
          <div className="rounded border border-border/70 px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">AWS</Badge>
              <code className="font-mono text-xs">
                {config.oidc.aws.audience}
              </code>
            </div>
            <code className="mt-1 block break-all font-mono text-xs text-muted-foreground">
              {config.oidc.aws.token_file}
            </code>
          </div>
        ) : null}
        {config.oidc.custom?.map((target) => (
          <div
            key={`${target.audience}:${target.token_file}`}
            className="rounded border border-border/70 px-3 py-2 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">Custom</Badge>
              <code className="font-mono text-xs">{target.audience}</code>
            </div>
            <code className="mt-1 block break-all font-mono text-xs text-muted-foreground">
              {target.token_file}
            </code>
          </div>
        ))}
      </div>,
    );
  }

  if (config.skills && Object.keys(config.skills).length > 0) {
    items.push(
      <div key="skills" className="space-y-2">
        <div className="text-xs text-muted-foreground">
          Skills ({Object.keys(config.skills).length} sources)
        </div>
        {Object.entries(config.skills).map(([source, skillSelection]) => (
          <div
            key={source}
            className="rounded border border-border/70 px-3 py-2"
          >
            <code className="block font-mono text-xs">{source}</code>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {skillSelection === 'all' ? (
                <Badge variant="secondary" className="font-mono text-xs">
                  all
                </Badge>
              ) : (
                skillSelection.map((skillName) => (
                  <Badge
                    key={`${source}-${skillName}`}
                    variant="secondary"
                    className="font-mono text-xs"
                  >
                    {skillName}
                  </Badge>
                ))
              )}
            </div>
          </div>
        ))}
      </div>,
    );
  }

  if (config.manualSkills && config.manualSkills.length > 0) {
    items.push(
      <div key="manual-skills" className="space-y-2">
        <div className="text-xs text-muted-foreground">
          Manual Skills ({config.manualSkills.length})
        </div>
        {config.manualSkills.map((manualSkill) => (
          <div
            key={manualSkill.name}
            className="rounded border border-border/70 px-3 py-2"
          >
            <code className="block font-mono text-xs">{manualSkill.name}</code>
            <p className="mt-1 text-xs text-muted-foreground">
              {manualSkill.description}
            </p>
          </div>
        ))}
      </div>,
    );
  }

  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    items.push(
      <div key="mcp-servers" className="space-y-2">
        <div className="text-xs text-muted-foreground">
          Custom MCP Servers ({Object.keys(config.mcpServers).length})
        </div>
        {Object.entries(config.mcpServers).map(([name, server]) => {
          const isStreamableHttp = 'url' in server;
          const transport = isStreamableHttp ? 'streamable-http' : 'stdio';
          return (
            <div
              key={name}
              className="rounded border border-border/70 px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <code className="font-mono text-xs">{name}</code>
                <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                  {transport}
                </Badge>
              </div>
              <code className="mt-1 block break-all font-mono text-xs text-muted-foreground">
                {isStreamableHttp
                  ? server.url
                  : [server.command, ...(server.args ?? [])].join(' ')}
              </code>
            </div>
          );
        })}
      </div>,
    );
  }

  return items;
}

function hasRecordEntries(record?: Record<string, string>) {
  return Boolean(record && Object.keys(record).length > 0);
}

function hasBasicContent(config: EnvironmentConfig) {
  return Boolean(config.name || config.initialUrl || config.description);
}

function getServiceName(service: ServiceConfig): ServiceName {
  return typeof service === 'string' ? service : service.name;
}
