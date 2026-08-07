'use client';

import type { ReactNode } from 'react';

import {
  BasicTooltip,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Info,
  InfoTooltip,
  Plus,
  PlugIcon,
  Settings2,
  Spinner,
  X,
} from '@/components/system';

export type IntegrationItem = {
  id: string;
  name: string;
  description: string;
  icon: ReactNode;
  enabled: boolean;
  configured?: boolean;
  needsConfiguration?: boolean;
  isMcpBased: boolean;
  /**
   * Rendered next to the title. Used to mark deployment-defined custom MCP
   * servers apart from the built-in catalog.
   */
  badge?: ReactNode;
  onAction?: () => void;
  isPending: boolean;
  actionLabel?: string;
  status?: ReactNode;
  statusIcon?: ReactNode;
  secondaryAction?: {
    label: string;
    ariaLabel: string;
    onAction: () => void;
    isPending: boolean;
    icon?: ReactNode;
  };
  headerAction?: {
    label: string;
    ariaLabel: string;
    onAction: () => void;
    isPending: boolean;
    icon: ReactNode;
  };
  utilityAction?: {
    label: string;
    ariaLabel: string;
    onAction: () => void;
    isPending: boolean;
    icon: ReactNode;
  };
  highlighted?: boolean;
};

function IntegrationCard({ item }: { item: IntegrationItem }) {
  const actionLabel = item.onAction
    ? (item.actionLabel ??
      (item.enabled ? `Disable ${item.name}` : `Enable ${item.name}`))
    : undefined;
  const integrationTypeContent = item.isMcpBased
    ? 'MCP-based integration'
    : 'First-class integration';
  const integrationTypeIcon = item.isMcpBased ? PlugIcon : Info;
  const footerActions = [item.secondaryAction, item.headerAction].filter(
    (action): action is NonNullable<IntegrationItem['secondaryAction']> =>
      action != null,
  );
  const iconColumnWidthClass = 'w-[34px]';

  return (
    <Card
      id={`integration-${item.id}`}
      className={`h-full gap-3 ${item.highlighted ? 'border-accent-foreground ring-2 ring-primary/50 bg-primary/5' : ''}`}
      data-highlighted={item.highlighted ? 'true' : undefined}
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className={`mt-0.5 flex ${iconColumnWidthClass} shrink-0 items-start justify-center`}
            >
              <div className="rounded-xl border border-border/70 bg-muted/30 p-2">
                {item.icon}
              </div>
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-1.5">
                <CardTitle className="text-base">{item.name}</CardTitle>
                {item.badge}
                <InfoTooltip
                  content={integrationTypeContent}
                  icon={integrationTypeIcon}
                  iconClassName="size-4"
                />
              </div>
              <CardDescription>{item.description}</CardDescription>
            </div>
          </div>

          {item.onAction || item.utilityAction ? (
            <div className="flex items-center gap-1">
              {item.utilityAction ? (
                <BasicTooltip content={item.utilityAction.label}>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={item.utilityAction.ariaLabel}
                    onClick={item.utilityAction.onAction}
                    disabled={item.utilityAction.isPending}
                  >
                    {item.utilityAction.isPending ? (
                      <Spinner size="sm" />
                    ) : (
                      item.utilityAction.icon
                    )}
                  </Button>
                </BasicTooltip>
              ) : null}
              {actionLabel ? (
                <BasicTooltip content={actionLabel}>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={actionLabel}
                    onClick={item.onAction}
                    disabled={item.isPending}
                  >
                    {item.isPending ? (
                      <Spinner size="sm" />
                    ) : item.needsConfiguration ? (
                      <Settings2 />
                    ) : item.enabled ? (
                      <X />
                    ) : (
                      <Plus />
                    )}
                  </Button>
                </BasicTooltip>
              ) : null}
            </div>
          ) : null}
        </div>
      </CardHeader>

      {item.status || footerActions.length > 0 ? (
        <CardContent>
          <div className="flex gap-3 p-0">
            <div
              className={`mt-0.5 ${iconColumnWidthClass} shrink-0`}
              aria-hidden="true"
            />
            <div className="min-w-0 space-y-3">
              {item.status && (
                <div className="flex items-start gap-2">
                  {item.statusIcon ? (
                    <span className="mt-0.5 shrink-0 text-destructive">
                      {item.statusIcon}
                    </span>
                  ) : null}
                  <p className="text-sm text-muted-foreground">{item.status}</p>
                </div>
              )}
              {footerActions.length > 0 ? (
                <div className="-ml-4 flex gap-2">
                  {footerActions.map((action) => (
                    <Button
                      key={action.ariaLabel}
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={action.ariaLabel}
                      onClick={action.onAction}
                      disabled={action.isPending}
                    >
                      {action.isPending ? <Spinner size="sm" /> : action.icon}
                      {action.label}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}

export function IntegrationSection({
  id,
  title,
  items,
  emptyState,
}: {
  id: string;
  title: string;
  items: IntegrationItem[];
  emptyState?: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-sm font-semibold text-foreground">
        {title}
      </h2>

      {items.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((item) => (
            <IntegrationCard key={item.id} item={item} />
          ))}
        </div>
      ) : (
        emptyState
      )}
    </section>
  );
}

export function splitIntegrationItems<
  T extends { enabled: boolean; configured?: boolean },
>(items: T[]) {
  return {
    installed: items.filter((item) => item.enabled),
    configured: items.filter((item) => !item.enabled && item.configured),
    available: items.filter((item) => !item.enabled && !item.configured),
  };
}
