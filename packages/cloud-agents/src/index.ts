/**
 * Cloud Agents package - Client-side exports.
 *
 * This module exports types and configurations that can be used
 * on both client and server side.
 */

export * from './utils';
export { STANDARD_TASK_MULTI_AGENT_GUIDANCE } from './standard-task-multi-agent-guidance';
export { ROOMOTE_COMPACT_PROMPT } from './compact-prompt';
export * from './file-attachments';
export {
  buildRoomoteSystemPrompt,
  ROOMOTE_SYSTEM_PROMPT,
} from './system-prompt';
export * from './style-guidance';
export * from './opencode-prompt-subagents';
export {
  DEFAULT_STANDARD_TASK_MODEL,
  DEFAULT_STANDARD_TASK_MODEL_PROVIDER,
  DEFAULT_STANDARD_TASK_REASONING_EFFORT,
} from './task-runtime-defaults';
export {
  PACKAGED_AUTOMATION_SKILL_INVOCATIONS,
  PACKAGED_SKILL_INVOCATIONS,
  PACKAGED_WORKFLOW_PHASE_SKILL_INVOCATIONS,
} from './packaged-skill-invocations';
export { VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES } from './video-agent-constants';
