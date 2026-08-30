import { format, formatDistanceToNowStrict } from 'date-fns';
import { enUS } from 'date-fns/locale';

import { ALL_REPOSITORIES } from '@roomote/types';

/**
 * Formats a number to be more readable (e.g., 2300 → 2.3K, 6700000 → 6.7M)
 * @param value The number to format
 * @returns Formatted string with appropriate suffix (K, M, B, T)
 */
export function formatNumber(value: number | undefined): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (value === 0) {
    return '0';
  }

  const absValue = Math.abs(value);

  if (absValue < 1000) {
    return value.toString();
  } else if (absValue < 1000000) {
    return `${(value / 1000).toFixed(1)}K`;
  } else if (absValue < 1000000000) {
    return `${(value / 1000000).toFixed(1)}M`;
  } else if (absValue < 1000000000000) {
    return `${(value / 1000000000).toFixed(1)}B`;
  } else {
    return `${(value / 1000000000000).toFixed(1)}T`;
  }
}

/**
 * Formats a number as currency (USD by default)
 * @param value The number to format as currency
 * @param options Options for formatting
 * @param options.currency The currency code (default: 'USD')
 * @param options.locale The locale to use for formatting (default: 'en-US')
 * @param options.compact If true, omits decimal places for whole numbers (default: false)
 * @returns Formatted currency string
 */
export function formatCurrency(
  value: number | undefined,
  options?: {
    currency?: string;
    locale?: string;
    compact?: boolean;
  },
): string {
  if (value === undefined || value === null) {
    return '';
  }

  const { currency = 'USD', locale = 'en-US', compact = false } = options ?? {};
  const digits = compact && value % 1 === 0 ? 0 : 2;

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

type FormatDistanceToNowCompactOptions = NonNullable<
  Parameters<typeof formatDistanceToNowStrict>[1]
>;

type EnUsFormatDistance = typeof enUS.formatDistance;
type FormatDistanceToken = Parameters<EnUsFormatDistance>[0];
type FormatDistanceOptions = Parameters<EnUsFormatDistance>[2];

const COMPACT_DISTANCE_UNITS: Partial<Record<FormatDistanceToken, string>> = {
  xSeconds: 's',
  xMinutes: 'min',
  xHours: 'h',
  xDays: 'd',
  xWeeks: 'w',
  xMonths: 'mo',
  xYears: 'y',
};

const compactLocale: typeof enUS = {
  ...enUS,
  formatDistance: (
    token: FormatDistanceToken,
    count: number,
    options?: FormatDistanceOptions,
  ): string => {
    const compactUnit = COMPACT_DISTANCE_UNITS[token];

    if (!compactUnit) {
      return enUS.formatDistance(token, count, options);
    }

    const compactDistance = `${count}${compactUnit}`;

    if (options?.addSuffix) {
      return options.comparison && options.comparison > 0
        ? `in ${compactDistance}`
        : `${compactDistance} ago`;
    }

    return compactDistance;
  },
};

/** Short calendar-day label ("Aug 19"), matching the analytics axes. */
export function formatShortDate(date: Date): string {
  return format(date, 'MMM d');
}

export function formatDistanceToNowCompact(
  date: Date | number,
  options?: FormatDistanceToNowCompactOptions,
): string {
  return formatDistanceToNowStrict(date, {
    ...options,
    locale: compactLocale,
  });
}

/**
 * Formats an inference cost stored as micro-USD into a human-readable USD
 * string with two decimal places (e.g., 1_500_000 -> "1.50", 0 -> "0.00").
 * @param costMicroUsd The cost in micro-USD (1 USD = 1_000_000 micro-USD)
 * @returns Formatted USD string
 */
export function formatInferenceCost(
  costMicroUsd: number | null | undefined,
): string {
  const normalizedCostMicroUsd = Math.max(0, Number(costMicroUsd ?? 0));

  if (
    !Number.isFinite(normalizedCostMicroUsd) ||
    normalizedCostMicroUsd === 0
  ) {
    return '0.00';
  }

  const costUsd = normalizedCostMicroUsd / 1_000_000;

  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(costUsd);
}

/**
 * Formats an IANA timezone identifier for display by replacing underscores
 * with spaces (e.g., "Africa/Addis_Ababa" -> "Africa/Addis Ababa"). The
 * canonical identifier should still be used when persisting values.
 * @param timeZone The IANA timezone identifier
 * @returns Human-readable timezone label
 */
export function formatTimeZone(timeZone: string): string {
  return timeZone.replaceAll('_', ' ');
}

/**
 * Formats tokens with appropriate suffix (K, M, B)
 * @param tokens The number of tokens to format
 * @returns Formatted string with appropriate suffix
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return tokens.toString();
  }

  if (tokens < 1000000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }

  if (tokens < 1000000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  }

  return `${(tokens / 1000000000).toFixed(1)}B`;
}

/**
 * Repository names may carry the ALL_REPOSITORIES sentinel; render its pretty
 * label instead of the raw `__all_repositories__` value.
 */
export function formatRepositoryName(name: string): string {
  // replaceAll also covers combined values like `repo#123` PR labels.
  return name.replaceAll(ALL_REPOSITORIES, 'All Repositories');
}
