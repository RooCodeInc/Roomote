import { FileText, Image, Type, Video, Volume2 } from '@/components/system';
import type { LucideIcon } from '@/components/system';
import type { TaskModelInputType, TaskModelMetadata } from '@roomote/types';

const INPUT_TYPE_ICONS: Record<TaskModelInputType, LucideIcon> = {
  text: Type,
  image: Image,
  video: Video,
  sound: Volume2,
  pdf: FileText,
};

const INPUT_TYPE_ORDER: TaskModelInputType[] = [
  'text',
  'image',
  'video',
  'sound',
  'pdf',
];

const DASH = '-';

function formatContextWindow(value: number | null | undefined): string {
  if (value === null || value === undefined || value <= 0) {
    return DASH;
  }
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${formatCompact(millions)}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${formatCompact(thousands)}k`;
  }
  return String(value);
}

function formatCompact(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(rounded < 10 ? 1 : 0).replace(/\.0$/, '');
}

function formatPrice(
  inputPricePerToken: number | null | undefined,
  outputPricePerToken: number | null | undefined,
): string {
  const input = formatSinglePrice(inputPricePerToken);
  const output = formatSinglePrice(outputPricePerToken);
  if (input === DASH && output === DASH) {
    return DASH;
  }
  return `${input} / ${output}`;
}

function formatSinglePrice(perToken: number | null | undefined): string {
  if (perToken === null || perToken === undefined || perToken < 0) {
    return DASH;
  }
  const perMillion = perToken * 1_000_000;
  if (perMillion === 0) {
    return '$0';
  }
  if (perMillion < 0.01) {
    return `<$0.01`;
  }
  const rounded = Math.round(perMillion * 100) / 100;
  return `$${rounded.toFixed(2)}`;
}

function getInputTypeIcons(
  types: TaskModelInputType[] | null | undefined,
): LucideIcon[] {
  if (!types || types.length === 0) {
    return [];
  }
  return INPUT_TYPE_ORDER.filter((type) => types.includes(type)).map(
    (type) => INPUT_TYPE_ICONS[type],
  );
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function formatLastRefreshed(iso: string | null | undefined): string {
  if (!iso) {
    return DASH;
  }
  const refreshedAt = Date.parse(iso);
  if (Number.isNaN(refreshedAt)) {
    return DASH;
  }
  const diffMs = Date.now() - refreshedAt;
  if (diffMs < 0) {
    return 'just now';
  }
  if (diffMs < MINUTE) {
    return 'just now';
  }
  if (diffMs < HOUR) {
    const minutes = Math.round(diffMs / MINUTE);
    return `${minutes}m ago`;
  }
  if (diffMs < DAY) {
    const hours = Math.round(diffMs / HOUR);
    return `${hours}h ago`;
  }
  const days = Math.round(diffMs / DAY);
  if (days === 1) {
    return 'yesterday';
  }
  if (days < 30) {
    return `${days}d ago`;
  }
  const date = new Date(refreshedAt);
  return date.toLocaleDateString();
}

export function formatMetadataSummary(metadata: TaskModelMetadata | null) {
  return {
    context: formatContextWindow(metadata?.contextWindow),
    price: formatPrice(
      metadata?.inputPricePerToken,
      metadata?.outputPricePerToken,
    ),
    inputTypeIcons: getInputTypeIcons(metadata?.inputTypes),
    lastRefreshed: formatLastRefreshed(metadata?.lastRefreshedAt),
  };
}
