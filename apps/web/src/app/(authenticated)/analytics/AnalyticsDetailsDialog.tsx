'use client';

import Link from 'next/link';

import type {
  AnalyticsDetailsResponse,
  AnalyticsMetric,
  AnalyticsObject,
} from '@/types';
import { formatInferenceCost, formatTokens } from '@/lib/formatters';
import { useIsMobile } from '@/hooks/useIsMobile';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Download,
  Skeleton,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  X,
} from '@/components/system';

type AnalyticsDetailsDialogProps = {
  object: AnalyticsObject;
  metric?: AnalyticsMetric;
  open: boolean;
  bucketLabel: string;
  seriesLabel: string;
  isLoading: boolean;
  isError: boolean;
  data: AnalyticsDetailsResponse | undefined;
  onDownload: () => void;
  isDownloadDisabled: boolean;
  onOpenChange: (open: boolean) => void;
};

const DIALOG_WIDTH_BY_OBJECT: Record<AnalyticsObject, string> = {
  sessions: 'md:w-[min(96vw,1160px)] md:max-w-[1160px]',
  tasks: 'md:w-[min(96vw,1160px)] md:max-w-[1160px]',
  pullRequests: 'md:w-[min(96vw,1240px)] md:max-w-[1240px]',
  costs: 'md:w-[min(96vw,1240px)] md:max-w-[1240px]',
};

const TABLE_MIN_WIDTH_BY_OBJECT: Record<AnalyticsObject, string> = {
  sessions: 'min-w-[900px] md:min-w-[1040px]',
  tasks: 'min-w-[980px] md:min-w-[1100px]',
  pullRequests: 'min-w-[1140px] md:min-w-[1220px]',
  costs: 'min-w-[1140px] md:min-w-[1220px]',
};

const SERIES_LABEL_MAX_LENGTH = 28;
const TASK_TITLE_CELL_MAX_LENGTH = 90;

function truncateTitleLabel(value: string, maxLength = 36) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function formatDetailsMetricTotal(
  metric: AnalyticsMetric | undefined,
  total: number,
) {
  switch (metric) {
    case 'tokens':
      return formatTokens(total);
    case 'cost':
      return `$${formatInferenceCost(total * 1_000_000)}`;
    case 'tasks':
    default:
      return String(total);
  }
}

function getDetailsDisplayValue(
  object: AnalyticsObject,
  columnKey: string,
  value: string,
) {
  if (object === 'tasks' && columnKey === 'taskTitle') {
    return truncateTitleLabel(value, TASK_TITLE_CELL_MAX_LENGTH);
  }

  if (object === 'tasks' && columnKey === 'tokens') {
    const tokens = Number(value);
    return Number.isFinite(tokens) ? formatTokens(tokens) : value;
  }

  if (object === 'tasks' && columnKey === 'cost') {
    const costUsd = Number(value);
    return Number.isFinite(costUsd)
      ? `$${formatInferenceCost(costUsd * 1_000_000)}`
      : value;
  }

  return value;
}

function DetailsCell({
  href,
  value,
  title,
}: {
  href?: string;
  value: string;
  title?: string;
}) {
  if (!href) {
    return <span title={title}>{value}</span>;
  }

  if (href.startsWith('/')) {
    return (
      <Link
        href={href}
        title={title}
        className="font-medium text-primary hover:underline"
      >
        {value}
      </Link>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      className="font-medium text-primary hover:underline"
    >
      {value}
    </a>
  );
}

export function AnalyticsDetailsDialog({
  object,
  metric = 'tasks',
  open,
  bucketLabel,
  seriesLabel,
  isLoading,
  isError,
  data,
  onDownload,
  isDownloadDisabled,
  onOpenChange,
}: AnalyticsDetailsDialogProps) {
  const isMobile = useIsMobile();
  const truncatedSeriesLabel = truncateTitleLabel(
    seriesLabel,
    SERIES_LABEL_MAX_LENGTH,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        size="max"
        className={[
          'ph-no-capture inset-x-auto bottom-auto left-1/2 top-1/2 w-[calc(100vw-2rem)] max-h-[calc(var(--effective-viewport-height)-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border p-4 md:p-6',
          'overflow-hidden',
          DIALOG_WIDTH_BY_OBJECT[object],
        ].join(' ')}
      >
        <DialogClose className="absolute top-4 right-4 rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none">
          <X className="size-5" />
          <span className="sr-only">Close</span>
        </DialogClose>

        <DialogHeader>
          <DialogTitle className="pr-12 text-left">
            {isMobile ? (
              <div className="max-w-[calc(100vw-8rem)] space-y-1 md:max-w-none">
                <div>{bucketLabel}</div>
                <div
                  className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap"
                  title={seriesLabel}
                >
                  {truncatedSeriesLabel}
                </div>
              </div>
            ) : (
              `${bucketLabel} · ${truncatedSeriesLabel}`
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Review the rows that make up the selected analytics chart segment.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : isError ? (
          <div className="rounded-2xl border border-border/60 bg-muted/20 px-4 py-6 text-sm text-muted-foreground">
            Unable to load details for this bar.
          </div>
        ) : (
          <div className="min-w-0 w-full rounded-2xl border border-border/60 bg-card">
            <div className="max-h-[60vh] w-full min-w-0 overflow-x-auto overflow-y-auto rounded-t-2xl overscroll-contain">
              <div
                className={`inline-block min-w-max align-top ${TABLE_MIN_WIDTH_BY_OBJECT[object]}`}
              >
                <table className="w-max min-w-max table-auto caption-bottom text-sm">
                  <TableHeader>
                    <TableRow>
                      {(data?.columns ?? []).map((column) => (
                        <TableHead key={column.key}>{column.label}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data && data.rows.length > 0 ? (
                      data.rows.map((row) => (
                        <TableRow key={row.id}>
                          {data.columns.map((column) => {
                            const rawValue = row.values[column.key] ?? '—';
                            const displayValue = getDetailsDisplayValue(
                              object,
                              column.key,
                              rawValue,
                            );
                            const title =
                              displayValue === rawValue ? undefined : rawValue;

                            return (
                              <TableCell key={column.key}>
                                <DetailsCell
                                  href={row.links?.[column.key]}
                                  value={displayValue}
                                  title={title}
                                />
                              </TableCell>
                            );
                          })}
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell
                          colSpan={data?.columns.length ?? 1}
                          className="h-32 text-center text-muted-foreground"
                        >
                          No matching rows.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </table>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Total</span>
                <span className="font-medium">
                  {formatDetailsMetricTotal(metric, data?.total ?? 0)}
                </span>
              </div>

              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-8 disabled:border-border/40 disabled:text-muted-foreground disabled:opacity-45 disabled:cursor-default disabled:hover:border-border/40 disabled:hover:text-muted-foreground"
                onClick={onDownload}
                disabled={isDownloadDisabled}
              >
                <Download className="size-4" />
                <span className="sr-only">Download details</span>
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
