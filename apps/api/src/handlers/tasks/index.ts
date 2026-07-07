import { Hono } from 'hono';

import type { Variables } from '../../types';
import { searchTasks } from './searchTasks';
import { getTaskSummary } from './getTaskSummary';
import { getTaskMessages } from './getTaskMessages';
import { launchTask } from './launchTask';
import { cancelTask } from './cancelTask';
import { stopTask } from './stopTask';
import { sendMessage } from './sendMessage';
import { steerMessage } from './steerMessage';
import { submitAutomationWorkItems } from './submitAutomationWorkItems';
import { submitTaskSuggestions } from './submitTaskSuggestions';
import { submitMcpRecommendations } from './submitMcpRecommendations';
import { getTaskComputeLogs } from './getTaskComputeLogs';
import { describeVideo } from './describeVideo';
import { manageSourceControl } from './manageSourceControl';

export const tasksRouter = new Hono<{ Variables: Variables }>();

tasksRouter.get('/', searchTasks);
tasksRouter.get('/:taskId/summary', getTaskSummary);
tasksRouter.get('/:taskId/messages', getTaskMessages);
tasksRouter.get('/:taskId/compute_logs', getTaskComputeLogs);
tasksRouter.post('/', launchTask);
tasksRouter.post('/:taskId/cancel', cancelTask);
tasksRouter.post('/:taskId/stop', stopTask);
tasksRouter.post('/:taskId/send_message', sendMessage);
tasksRouter.post('/:taskId/steer_message', steerMessage);
tasksRouter.post('/:taskId/describe_video', describeVideo);
tasksRouter.post('/:taskId/source_control', manageSourceControl);
tasksRouter.post('/:taskId/automation_work_items', submitAutomationWorkItems);
tasksRouter.post('/:taskId/task_suggestions', submitTaskSuggestions);
tasksRouter.post('/:taskId/mcp_recommendations', submitMcpRecommendations);
