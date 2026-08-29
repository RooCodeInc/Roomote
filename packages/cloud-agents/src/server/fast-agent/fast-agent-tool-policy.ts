import {
  FAST_AGENT_NATIVE_TOOL_NAMES,
  FAST_AGENT_SETUP_ONLY_NATIVE_TOOL_NAMES,
  getFastAgentNativeAcpKind,
  isFastAgentSetupOnlyNativeTool,
  type FastAgentNativeToolName,
} from '@roomote/types';

export {
  FAST_AGENT_NATIVE_TOOL_NAMES,
  getFastAgentNativeAcpKind,
  isFastAgentSetupOnlyNativeTool,
  type FastAgentNativeToolName,
};

export const FAST_AGENT_NATIVE_TOOL_FILTER: Record<string, boolean> = {
  '*': false,
  task: true,
  ...Object.fromEntries(
    Object.values(FAST_AGENT_NATIVE_TOOL_NAMES)
      .filter((name) => !isFastAgentSetupOnlyNativeTool(name))
      .map((name) => [name, true]),
  ),
};

const FAST_AGENT_SETUP_NATIVE_TOOL_FILTER: Record<string, boolean> = {
  ...FAST_AGENT_NATIVE_TOOL_FILTER,
  ...Object.fromEntries(
    FAST_AGENT_SETUP_ONLY_NATIVE_TOOL_NAMES.map((name) => [name, true]),
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
  options: { setupSession?: boolean } = {},
): Record<string, boolean> {
  return {
    ...(options.setupSession
      ? FAST_AGENT_SETUP_NATIVE_TOOL_FILTER
      : FAST_AGENT_NATIVE_TOOL_FILTER),
    ...Object.fromEntries(integrationIds.map((id) => [`${id}_*`, true])),
  };
}

export function isFastAgentSpillTool(name: FastAgentNativeToolName): boolean {
  return (
    name === FAST_AGENT_NATIVE_TOOL_NAMES.spillRead ||
    name === FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep
  );
}
