import { Hono } from 'hono';

import type { Variables } from '../../types';

export { installDesktopDeviceBroker } from './broker';

export const desktopDevicesRouter = new Hono<{ Variables: Variables }>();

desktopDevicesRouter.get('/connect', (c) =>
  c.json({ error: 'websocket_upgrade_required' }, 426),
);
