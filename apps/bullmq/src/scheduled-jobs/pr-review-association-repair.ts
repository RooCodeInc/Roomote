import { repairOrphanPrReviewAssociationReplays } from '@roomote/sdk/server';

export async function prReviewAssociationRepairJob(): Promise<void> {
  await repairOrphanPrReviewAssociationReplays();
}
