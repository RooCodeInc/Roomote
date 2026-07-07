import path from 'node:path';

import { WorkerReleaseService } from './services/worker-release';

const rootDir = path.resolve(process.cwd(), '../..');

WorkerReleaseService.buildLocalDevRelease({
  rootDir,
  version: 'local-dev',
})
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
