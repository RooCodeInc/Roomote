import { BRAIN_NAMESPACES } from '@roomote/types';

import type {
  BrainNamespaceSummary,
  BrainSourceStatus,
  BrainStatus,
} from '@/trpc/commands/brain';

/**
 * Same palette and same omission as the analytics charts: chart-6 is the red
 * used for failure, so it never colors a neutral category.
 */
const NAMESPACE_COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
  'var(--color-chart-7)',
];

/** The catch-all bucket is deliberately colorless: it names nothing. */
const OTHER_NAMESPACE_COLOR = 'var(--color-muted-foreground)';

/**
 * Color follows the namespace, never its rank: keyed off the registry's
 * stable order rather than the size-sorted chart order, so Slack keeps its
 * hue when it overtakes Meetings, and any second surface (the browse dialog's
 * chips) can reproduce the same colors without reproducing the sort. A hue
 * repeat across the ten namespaces is fine because every segment is labelled.
 */
export function brainNamespaceColor(id: string): string {
  const index = BRAIN_NAMESPACES.findIndex((namespace) => namespace.id === id);

  return index === -1
    ? OTHER_NAMESPACE_COLOR
    : NAMESPACE_COLORS[index % NAMESPACE_COLORS.length]!;
}

type BrainNamespaceSegment = BrainNamespaceSummary & {
  color: string;
  /** Share of the sample, 0-100. */
  percent: number;
};

export function buildNamespaceSegments(
  namespaces: BrainNamespaceSummary[],
): BrainNamespaceSegment[] {
  const total = namespaces.reduce((sum, namespace) => sum + namespace.pages, 0);

  if (total === 0) {
    return [];
  }

  return namespaces.map((namespace) => ({
    ...namespace,
    color: brainNamespaceColor(namespace.id),
    percent: (namespace.pages / total) * 100,
  }));
}

type BrainStatusPresentation = {
  label: string;
  /** Tailwind background class for the status dot. */
  dotClassName: string;
  tone: 'ok' | 'warning' | 'neutral';
};

export function describeBrainStatus(
  status: BrainStatus,
): BrainStatusPresentation {
  switch (status) {
    case 'connected':
      return {
        label: 'Connected',
        dotClassName: 'bg-accent-foreground',
        tone: 'ok',
      };
    case 'unreachable':
      return {
        label: 'Unreachable',
        dotClassName: 'bg-destructive',
        tone: 'warning',
      };
    case 'incomplete':
      return {
        label: 'Needs attention',
        dotClassName: 'bg-warning',
        tone: 'warning',
      };
    case 'not_configured':
    default:
      return {
        label: 'Not configured',
        dotClassName: 'bg-muted-foreground',
        tone: 'neutral',
      };
  }
}

type BrainSourceStatusPresentation = {
  label: string;
  variant: 'success' | 'warning' | 'secondary' | 'outline';
  /** Shown under the row when the state benefits from a word of context. */
  hint: string | null;
};

export function describeSourceStatus(
  status: BrainSourceStatus,
): BrainSourceStatusPresentation {
  switch (status) {
    case 'ingesting':
      return { label: 'Connected', variant: 'success', hint: null };
    case 'backfilling':
      return {
        label: 'Backfilling',
        variant: 'warning',
        hint: 'Reading history in bounded steps. New activity is already being collected.',
      };
    case 'idle':
      return {
        label: 'Waiting',
        variant: 'secondary',
        hint: 'Connected, but nothing has been collected yet.',
      };
    case 'not_connected':
    default:
      return {
        label: 'Not connected',
        variant: 'outline',
        hint: 'Connect this integration to let Memory read it.',
      };
  }
}

export const BRAIN_INFERENCE_PROVIDER_LABELS: Record<
  'openrouter' | 'openai',
  string
> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
};
