'use client';

import { useState, useTransition } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

import {
  type AnalyticsDimension,
  type AnalyticsFilters,
  type AnalyticsGranularity,
  type AnalyticsMetric,
  type AnalyticsObject,
  type TimePeriodFilter,
  ANALYTICS_OBJECT_CONFIG,
  getAnalyticsAxisLabel,
  getAvailableAnalyticsGranularities,
  getDefaultAnalyticsGranularity,
  getDefaultAnalyticsMetric,
  getDefaultAnalyticsViewBy,
  isValidAnalyticsGranularity,
  isValidAnalyticsMetric,
  isValidAnalyticsViewBy,
  analyticsObjects,
  parseTimePeriodParam,
} from '@/types';
import {
  useAnalyticsDetails,
  useAnalyticsOverview,
  usePullRequestAnalyticsOverview,
} from '@/hooks/analytics';
import { useDelayedRefetchLoading } from '@/hooks/useDelayedRefetchLoading';
import { useTRPC } from '@/trpc/client';

import { AnalyticsControlRow } from './AnalyticsControlRow';
import { AnalyticsDetailsDialog } from './AnalyticsDetailsDialog';
import { AnalyticsFilterBar } from './AnalyticsFilterBar';
import {
  AnalyticsShell,
  AnalyticsShellDownloadAction,
  getAnalyticsHref,
} from './AnalyticsShell';
import { AnalyticsStackedBarChart } from './AnalyticsStackedBarChart';
import { PullRequestSummaryCards } from './PullRequestSummaryCards';
import { CostBreakdownTable } from './CostBreakdownTable';
import { CostSummaryCards } from './CostSummaryCards';
import { downloadAnalyticsRowsCsv } from './downloadCsv';

const analyticsFilterKeys = [
  'user',
  'project',
  'source',
  'status',
  'repo',
  'author',
  'taskType',
  'provider',
  'model',
  'ownerKind',
  'hasExecution',
] as const;

type SelectedAnalyticsSegment = {
  bucketKey: string;
  bucketLabel: string;
  seriesKey: string;
  seriesLabel: string;
};

const GENERIC_ANALYTICS_OBJECTS: AnalyticsObject[] = [
  'tasks',
  'sessions',
  'pullRequests',
];

function parseAnalyticsObject(
  value: string | null,
  allowedObjects: readonly AnalyticsObject[] = analyticsObjects,
): AnalyticsObject {
  if (value && allowedObjects.includes(value as AnalyticsObject)) {
    return value as AnalyticsObject;
  }

  return allowedObjects[0] ?? analyticsObjects[0] ?? 'tasks';
}

function getFiltersFromSearchParams(
  searchParams: URLSearchParams,
): AnalyticsFilters {
  const filters: AnalyticsFilters = {};

  for (const key of analyticsFilterKeys) {
    const values = searchParams.getAll(key).filter(Boolean);
    if (values.length > 0) {
      filters[key] = values;
    }
  }

  return filters;
}

export function Analytics({
  fixedObject,
}: { fixedObject?: AnalyticsObject } = {}) {
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const [isExporting, setIsExporting] = useState(false);
  const [reloadRequestId, setReloadRequestId] = useState(0);
  const [selectedSegment, setSelectedSegment] =
    useState<SelectedAnalyticsSegment | null>(null);
  const [isParamsTransitionPending, startParamsTransition] = useTransition();

  const object =
    fixedObject ??
    parseAnalyticsObject(searchParams.get('object'), GENERIC_ANALYTICS_OBJECTS);
  const basePath = fixedObject ? getAnalyticsHref(fixedObject) : '/analytics';
  const filters = getFiltersFromSearchParams(searchParams);
  const timePeriod = parseTimePeriodParam(searchParams.get('timePeriod'), 7);
  const requestedViewBy = searchParams.get('viewBy');
  const granularityParam = searchParams.get('granularity');
  const viewBy = isValidAnalyticsViewBy(object, requestedViewBy)
    ? requestedViewBy
    : getDefaultAnalyticsViewBy(object);
  const requestedMetric = searchParams.get('metric');
  const metric = isValidAnalyticsMetric(object, requestedMetric)
    ? requestedMetric
    : getDefaultAnalyticsMetric(object);
  const granularity = isValidAnalyticsGranularity(timePeriod, granularityParam)
    ? (granularityParam as AnalyticsGranularity)
    : getDefaultAnalyticsGranularity(timePeriod);
  const availableGranularities = getAvailableAnalyticsGranularities(timePeriod);
  const analyticsReloadKey = String(reloadRequestId);

  const overviewQuery = useAnalyticsOverview(
    {
      object,
      viewBy,
      metric,
      filters,
      timePeriod,
      granularity,
    },
    { enabled: object !== 'pullRequests' },
  );
  const pullRequestOverviewQuery = usePullRequestAnalyticsOverview(
    {
      viewBy,
      filters,
      timePeriod,
      granularity,
    },
    { enabled: object === 'pullRequests' },
  );
  const detailsQuery = useAnalyticsDetails(
    selectedSegment
      ? {
          object,
          viewBy,
          metric,
          filters,
          timePeriod,
          granularity,
          bucketKey: selectedSegment.bucketKey,
          seriesKey: selectedSegment.seriesKey,
        }
      : null,
  );

  const config = ANALYTICS_OBJECT_CONFIG[object];
  const axisLabel = getAnalyticsAxisLabel(object, metric);
  const chart =
    object === 'pullRequests'
      ? pullRequestOverviewQuery.data?.chart
      : overviewQuery.data?.chart;
  const filterOptions =
    object === 'pullRequests'
      ? (pullRequestOverviewQuery.data?.filterOptions.filters ?? {})
      : (overviewQuery.data?.filterOptions.filters ?? {});
  const activeChartQuery =
    object === 'pullRequests' ? pullRequestOverviewQuery : overviewQuery;
  const showChartReloadLoading = useDelayedRefetchLoading({
    loadingKey: analyticsReloadKey,
    isFetching: isParamsTransitionPending || activeChartQuery.isFetching,
    isInitialLoading: activeChartQuery.isLoading,
  });
  const showPullRequestSummaryReloadLoading = useDelayedRefetchLoading({
    loadingKey: analyticsReloadKey,
    isFetching:
      isParamsTransitionPending || pullRequestOverviewQuery.isFetching,
    isInitialLoading: pullRequestOverviewQuery.isLoading,
  });
  const shouldShowChartLoading =
    activeChartQuery.isLoading || showChartReloadLoading;
  const shouldShowPullRequestSummaryLoading =
    pullRequestOverviewQuery.isLoading || showPullRequestSummaryReloadLoading;

  const updateParams = (mutate: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    const query = params.toString();
    setReloadRequestId((current) => current + 1);
    startParamsTransition(() => {
      router.replace(query ? `${basePath}?${query}` : basePath, {
        scroll: false,
      });
    });
  };

  const resetSelection = () => setSelectedSegment(null);

  const handleObjectChange = (nextObject: AnalyticsObject) => {
    if (nextObject === object) {
      return;
    }

    if (fixedObject || nextObject === 'costs') {
      resetSelection();
      startParamsTransition(() => {
        router.push(getAnalyticsHref(nextObject));
      });
      return;
    }

    resetSelection();
    updateParams((params) => {
      if (nextObject === 'tasks') {
        params.delete('object');
      } else {
        params.set('object', nextObject);
      }
      params.set('viewBy', getDefaultAnalyticsViewBy(nextObject));
      params.delete('metric');
      for (const key of analyticsFilterKeys) {
        params.delete(key);
      }
      params.delete('timePeriod');
      params.delete('granularity');
    });
  };

  const handleViewByChange = (nextViewBy: AnalyticsDimension) => {
    resetSelection();
    updateParams((params) => {
      params.set('viewBy', nextViewBy);
    });
  };

  const handleMetricChange = (nextMetric: AnalyticsMetric) => {
    resetSelection();
    updateParams((params) => {
      if (nextMetric === getDefaultAnalyticsMetric(object)) {
        params.delete('metric');
      } else {
        params.set('metric', nextMetric);
      }
    });
  };

  const handleFilterChange = (
    dimension: AnalyticsDimension,
    values: string[],
  ) => {
    resetSelection();
    updateParams((params) => {
      params.delete(dimension);

      for (const value of values) {
        params.append(dimension, value);
      }
    });
  };

  const handleTimePeriodChange = (value: TimePeriodFilter) => {
    resetSelection();
    updateParams((params) => {
      params.set('timePeriod', String(value));
      params.delete('granularity');
    });
  };

  const handleGranularityChange = (value: AnalyticsGranularity) => {
    resetSelection();
    updateParams((params) => {
      params.set('granularity', value);
    });
  };

  const handleResetFilters = () => {
    resetSelection();
    updateParams((params) => {
      for (const key of analyticsFilterKeys) {
        params.delete(key);
      }
      params.delete('timePeriod');
      params.delete('granularity');
    });
  };

  const hasChartData = (chart?.total ?? 0) > 0;
  const isRegularDownloadDisabled =
    isExporting ||
    activeChartQuery.isLoading ||
    activeChartQuery.isError ||
    !hasChartData;
  const isDetailsDownloadDisabled =
    detailsQuery.isLoading ||
    detailsQuery.isError ||
    (detailsQuery.data?.rows.length ?? 0) === 0;

  const handleDownloadData = async () => {
    if (isRegularDownloadDisabled) {
      return;
    }

    try {
      setIsExporting(true);
      const exportData = await queryClient.fetchQuery(
        trpc.analytics.export.queryOptions({
          object,
          viewBy,
          metric,
          filters,
          timePeriod,
          granularity,
        }),
      );

      if (exportData.rows.length === 0) {
        return;
      }

      downloadAnalyticsRowsCsv({
        data: exportData,
        filenamePrefix: 'analytics',
        filenameParts: [object, viewBy, 'all-rows'],
      });
    } catch {
      toast.error('Unable to download analytics data.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleDownloadDetails = () => {
    if (!selectedSegment || !detailsQuery.data || isDetailsDownloadDisabled) {
      return;
    }

    downloadAnalyticsRowsCsv({
      data: detailsQuery.data,
      filenamePrefix: 'analytics-details',
      filenameParts: [
        object,
        viewBy,
        selectedSegment.bucketLabel,
        selectedSegment.seriesLabel,
      ],
    });
  };

  return (
    <div className="ph-no-capture min-h-full w-full bg-background">
      <AnalyticsShell
        activeItemId={object}
        title={config.label}
        headerAction={
          <AnalyticsShellDownloadAction
            isDisabled={isRegularDownloadDisabled}
            isExporting={isExporting}
            onDownload={handleDownloadData}
          />
        }
        onItemSelect={handleObjectChange}
      >
        <div className="space-y-0.5 rounded-lg overflow-clip">
          <div className="overflow-hidden bg-card flex flex-row flex-wrap items-center gap-2 px-4 py-2">
            <AnalyticsFilterBar
              object={object}
              filters={filters}
              filterOptions={filterOptions}
              onFilterChange={handleFilterChange}
              onResetFilters={handleResetFilters}
            />

            <div className="hidden grow md:block" />

            <AnalyticsControlRow
              object={object}
              viewBy={chart?.viewBy ?? viewBy}
              metric={chart?.metric ?? metric}
              timePeriod={timePeriod}
              granularity={granularity}
              availableGranularities={availableGranularities}
              onViewByChange={handleViewByChange}
              onMetricChange={handleMetricChange}
              onTimePeriodChange={handleTimePeriodChange}
              onGranularityChange={handleGranularityChange}
            />
          </div>
          {object === 'pullRequests' ? (
            <PullRequestSummaryCards
              summary={pullRequestOverviewQuery.data?.summary}
              isLoading={shouldShowPullRequestSummaryLoading}
              isError={pullRequestOverviewQuery.isError}
              granularity={granularity}
            />
          ) : null}
          {object === 'costs' ? (
            <CostSummaryCards
              summary={chart?.costSummary}
              timePeriod={timePeriod}
            />
          ) : null}

          <div className="overflow-hidden bg-card p-4">
            <AnalyticsStackedBarChart
              axisLabel={axisLabel}
              chart={chart}
              granularity={granularity}
              isLoading={shouldShowChartLoading}
              isError={activeChartQuery.isError}
              onResetFilters={handleResetFilters}
              onSelectSegment={setSelectedSegment}
            />
            {object === 'costs' ? (
              <CostBreakdownTable rows={chart?.costBreakdown} />
            ) : null}
          </div>
        </div>
      </AnalyticsShell>

      <AnalyticsDetailsDialog
        object={object}
        metric={metric}
        open={selectedSegment !== null}
        bucketLabel={selectedSegment?.bucketLabel ?? ''}
        seriesLabel={selectedSegment?.seriesLabel ?? ''}
        isLoading={detailsQuery.isLoading}
        isError={detailsQuery.isError}
        data={detailsQuery.data}
        onDownload={handleDownloadDetails}
        isDownloadDisabled={isDetailsDownloadDisabled}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedSegment(null);
          }
        }}
      />
    </div>
  );
}
