import {
  FAST_AGENT_NATIVE_TOOL_NAMES,
  getFastAgentNativeAcpKind,
  type FastAgentSurface,
  type FastAgentNativeToolName,
} from '@roomote/types';

export {
  FAST_AGENT_NATIVE_TOOL_NAMES,
  getFastAgentNativeAcpKind,
  type FastAgentNativeToolName,
};

export const FAST_AGENT_NATIVE_TOOL_FILTER: Record<string, boolean> = {
  '*': false,
  task: true,
  ...Object.fromEntries(
    Object.values(FAST_AGENT_NATIVE_TOOL_NAMES).map((name) => [name, true]),
  ),
};

export const FAST_AGENT_SUBAGENT_TOOL_FILTER: Record<string, boolean> = {
  '*': true,
  task: false,
  roomote_manage_custom_automations: false,
  ...Object.fromEntries(
    Object.values(FAST_AGENT_NATIVE_TOOL_NAMES).map((name) => [name, false]),
  ),
};

export function buildFastAgentToolFilter(
  integrationIds: string[],
  options: { surface?: FastAgentSurface } = {},
): Record<string, boolean> {
  return {
    ...FAST_AGENT_NATIVE_TOOL_FILTER,
    ...(options.surface && options.surface !== 'web'
      ? { [FAST_AGENT_NATIVE_TOOL_NAMES.requestUserInput]: false }
      : {}),
    ...Object.fromEntries(integrationIds.map((id) => [`${id}_*`, true])),
  };
}

export function isFastAgentSpillTool(name: FastAgentNativeToolName): boolean {
  return (
    name === FAST_AGENT_NATIVE_TOOL_NAMES.spillRead ||
    name === FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep
  );
}
