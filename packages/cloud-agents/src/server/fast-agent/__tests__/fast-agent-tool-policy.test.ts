import { ACP_TOOL_KINDS, FAST_AGENT_NATIVE_TOOL_CATALOG } from '@roomote/types';

import {
  FAST_AGENT_NATIVE_TOOL_NAMES,
  FAST_AGENT_NATIVE_TOOL_FILTER,
  FAST_AGENT_SUBAGENT_TOOL_FILTER,
  buildFastAgentToolFilter,
  getFastAgentNativeAcpKind,
} from '../fast-agent-tool-policy';

describe('getFastAgentNativeAcpKind', () => {
  it.each([
    [
      FAST_AGENT_NATIVE_TOOL_NAMES.requestWithSessionSecret,
      ACP_TOOL_KINDS.read,
    ],
    [FAST_AGENT_NATIVE_TOOL_NAMES.prepareSessionSecret, ACP_TOOL_KINDS.tool],
    [FAST_AGENT_NATIVE_TOOL_NAMES.listSessionSecrets, ACP_TOOL_KINDS.list],
  ])('exposes %s only to the Fast parent', (name, kind) => {
    expect(FAST_AGENT_NATIVE_TOOL_FILTER[name]).toBe(true);
    expect(buildFastAgentToolFilter([], { surface: 'web' })[name]).toBe(true);
    expect(buildFastAgentToolFilter([], { surface: 'slack' })[name]).toBe(true);
    expect(FAST_AGENT_SUBAGENT_TOOL_FILTER[name]).toBe(false);
    expect(getFastAgentNativeAcpKind(name)).toBe(kind);
  });

  it.each(FAST_AGENT_NATIVE_TOOL_CATALOG)(
    'maps every catalogued tool (%s) to its ACP kind',
    ({ name, kind }) => {
      expect(getFastAgentNativeAcpKind(name)).toBe(kind);
    },
  );

  it.each([
    [FAST_AGENT_NATIVE_TOOL_NAMES.spillRead, ACP_TOOL_KINDS.read],
    [FAST_AGENT_NATIVE_TOOL_NAMES.loadSkill, ACP_TOOL_KINDS.read],
    [FAST_AGENT_NATIVE_TOOL_NAMES.spillGrep, ACP_TOOL_KINDS.search],
    [FAST_AGENT_NATIVE_TOOL_NAMES.listSkills, ACP_TOOL_KINDS.list],
    [FAST_AGENT_NATIVE_TOOL_NAMES.launchTask, ACP_TOOL_KINDS.task],
    [FAST_AGENT_NATIVE_TOOL_NAMES.sendTaskMessage, ACP_TOOL_KINDS.task],
    [FAST_AGENT_NATIVE_TOOL_NAMES.sendChatReply, ACP_TOOL_KINDS.communication],
    [FAST_AGENT_NATIVE_TOOL_NAMES.saveMemory, ACP_TOOL_KINDS.memory],
    [FAST_AGENT_NATIVE_TOOL_NAMES.createArtifact, ACP_TOOL_KINDS.artifact],
    [FAST_AGENT_NATIVE_TOOL_NAMES.showWidget, ACP_TOOL_KINDS.widget],
  ])('maps %s to %s', (name, expected) => {
    expect(getFastAgentNativeAcpKind(name)).toBe(expected);
  });
});
