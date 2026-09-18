import { describe, expect, it } from 'vitest';

import { getDesktopDeviceRoutingStatus } from './roomote-desktop-tools';

describe('getDesktopDeviceRoutingStatus', () => {
  it('reports a locally owned socket online', () => {
    expect(
      getDesktopDeviceRoutingStatus({
        localSocketOnline: true,
        lastInstanceId: 'api-a',
        currentInstanceId: 'api-a',
      }),
    ).toEqual({ online: true, routedElsewhere: false });
  });

  it('lets persisted instance ownership override a stale local socket', () => {
    expect(
      getDesktopDeviceRoutingStatus({
        localSocketOnline: true,
        lastInstanceId: 'api-b',
        currentInstanceId: 'api-a',
      }),
    ).toEqual({ online: false, routedElsewhere: true });
  });

  it('does not report an offline local device as routed elsewhere', () => {
    expect(
      getDesktopDeviceRoutingStatus({
        localSocketOnline: false,
        lastInstanceId: 'api-a',
        currentInstanceId: 'api-a',
      }),
    ).toEqual({ online: false, routedElsewhere: false });
  });
});
