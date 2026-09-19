import { drainReleaseAnnouncementDeliveries } from '@roomote/sdk/server';

export async function releaseAnnouncementsJob(): Promise<void> {
  await drainReleaseAnnouncementDeliveries();
}
