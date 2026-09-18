import { Env } from '@roomote/env';
import {
  drainReleaseAnnouncementDeliveries,
  recordInstalledRelease,
} from '@roomote/sdk/server';

const version = Env.RELEASE_PRODUCT_VERSION ?? Env.RELEASE_VERSION;
if (!version) {
  console.error('Release announcement skipped: no product release version');
  process.exitCode = 1;
} else {
  const result = await recordInstalledRelease(version);
  const delivery = await drainReleaseAnnouncementDeliveries();
  console.info(
    `Installed release ${version}: ${result}; delivered ${delivery.delivered}, deferred ${delivery.failed}`,
  );
}
