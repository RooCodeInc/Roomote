import { getStatuspageIncident } from '@roomote/slack';

import { optionalAuthProcedure, router } from '../trpc';

export const statuspageRouter = router({
  incident: optionalAuthProcedure.query(() => getStatuspageIncident()),
});
