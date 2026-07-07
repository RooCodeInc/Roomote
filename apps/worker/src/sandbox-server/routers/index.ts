import { router } from '../trpc';

import { commandsRouter } from './commands';

export const appRouter = router({ commands: commandsRouter });

export type AppRouter = typeof appRouter;
