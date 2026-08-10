import {
  listPrReviewAggregateIdsNeedingDelivery,
  prunePrReviewNotificationState,
  releaseStalePrReviewFixClaims,
} from '@roomote/db/server';
import { schedulePrReviewAggregateDelivery } from '@roomote/sdk/server';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function prReviewNotificationRepairJob(): Promise<void> {
  await releaseStalePrReviewFixClaims();
  const aggregateIds = await listPrReviewAggregateIdsNeedingDelivery();

  await Promise.all(
    aggregateIds.map((aggregateId) =>
      schedulePrReviewAggregateDelivery(aggregateId).catch((error) => {
        console.error(
          `[PrReviewNotificationRepair] Failed to enqueue aggregate ${aggregateId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }),
    ),
  );

  await prunePrReviewNotificationState(new Date(Date.now() - RETENTION_MS));
}
