import { router } from '../trpc';

import {
  tailMulti,
  diffOutput,
  searchFiles,
  getRuntimeState,
  getHarnessLog,
  getSetupStatus,
  sendPrompt,
  steerTask,
  steerQueuedMessage,
  reorderQueuedMessage,
  deleteQueuedPrompt,
  answerUserInputRequest,
  sandboxStream,
  cancelTask,
  touchKeepalive,
  reloadDeploymentEnvVars,
} from '../procedures';

export const commandsRouter = router({
  tailMulti,
  diffOutput,
  searchFiles,
  getRuntimeState,
  getHarnessLog,
  getSetupStatus,
  sendPrompt,
  steerTask,
  steerQueuedMessage,
  reorderQueuedMessage,
  deleteQueuedPrompt,
  answerUserInputRequest,
  sandboxStream,
  cancelTask,
  touchKeepalive,
  reloadDeploymentEnvVars,
});
