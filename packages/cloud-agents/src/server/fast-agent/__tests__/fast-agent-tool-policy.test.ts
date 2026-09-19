import { ACP_TOOL_KINDS, FAST_AGENT_NATIVE_TOOL_CATALOG } from '@roomote/types';

import {
  FAST_AGENT_NATIVE_TOOL_NAMES,
  FAST_AGENT_NATIVE_TOOL_FILTER,
  FAST_AGENT_SUBAGENT_TOOL_FILTER,
  buildFastAgentSubagentToolFilter,
  buildFastAgentToolFilter,
  getFastAgentNativeAcpKind,
} from '../fast-agent-tool-policy';

describe('buildFastAgentToolFilter', () => {
  it('keeps unrestricted control-plane tools unavailable', () => {
    const filter = buildFastAgentToolFilter([], { surface: 'web' });

    expect(filter).toMatchObject({
      '*': false,
      task: true,
    });
    expect(filter.webfetch).not.toBe(true);
    expect(filter.bash).not.toBe(true);
    expect(filter.read).not.toBe(true);
    expect(filter.edit).not.toBe(true);
    expect(filter[FAST_AGENT_NATIVE_TOOL_NAMES.reportPlatformIssue]).toBe(true);
    expect(
      buildFastAgentToolFilter([], { surface: 'slack' })[
        FAST_AGENT_NATIVE_TOOL_NAMES.reportPlatformIssue
      ],
    ).toBe(true);
    expect(
      FAST_AGENT_SUBAGENT_TOOL_FILTER[
        FAST_AGENT_NATIVE_TOOL_NAMES.reportPlatformIssue
      ],
    ).toBe(false);
  });
});

describe('getFastAgentNativeAcpKind', () => {
  it('keeps integration discovery and approval setup available', () => {
    const filter = buildFastAgentToolFilter([], {
      surface: 'web',
      serviceCredentialToolsEnabled: true,
    });
    expect(filter[FAST_AGENT_NATIVE_TOOL_NAMES.listServiceCredentials]).toBe(
      true,
    );
    expect(filter[FAST_AGENT_NATIVE_TOOL_NAMES.prepareServiceCredential]).toBe(
      true,
    );
    expect(filter[FAST_AGENT_NATIVE_TOOL_NAMES.findIntegrationTools]).toBe(
      true,
    );
    expect(filter[FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool]).toBe(true);
    expect(
      FAST_AGENT_SUBAGENT_TOOL_FILTER[
        FAST_AGENT_NATIVE_TOOL_NAMES.findIntegrationTools
      ],
    ).toBe(true);
    expect(
      FAST_AGENT_SUBAGENT_TOOL_FILTER[
        FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool
      ],
    ).toBe(true);
  });

  it('keeps the dispatcher path unchanged when the code-mode experiment is off', () => {
    const filter = buildFastAgentToolFilter(['github'], {
      surface: 'web',
      codeModeIntegrationsEnabled: false,
    });

    expect(filter.execute).not.toBe(true);
    expect(filter[FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool]).toBe(true);
    expect(filter[FAST_AGENT_NATIVE_TOOL_NAMES.findIntegrationTools]).toBe(
      true,
    );
    expect(filter['github_*']).toBe(true);
  });

  it('retires call_integration_tool and exposes execute when the experiment is on', () => {
    const filter = buildFastAgentToolFilter(['github'], {
      surface: 'web',
      codeModeIntegrationsEnabled: true,
    });

    expect(filter.execute).toBe(true);
    expect(filter[FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool]).toBe(
      false,
    );
    // Discovery stays for the built-in integration catalog and statuses.
    expect(filter[FAST_AGENT_NATIVE_TOOL_NAMES.findIntegrationTools]).toBe(
      true,
    );
    expect(filter['github_*']).toBe(true);
    // The fail-closed posture for everything else is unchanged.
    expect(filter['*']).toBe(false);
    expect(filter.bash).not.toBe(true);
  });

  it('drops call_integration_tool for helper subagents only when the experiment is on', () => {
    expect(buildFastAgentSubagentToolFilter()).toBe(
      FAST_AGENT_SUBAGENT_TOOL_FILTER,
    );
    expect(
      buildFastAgentSubagentToolFilter({ codeModeIntegrationsEnabled: false }),
    ).toBe(FAST_AGENT_SUBAGENT_TOOL_FILTER);

    const filter = buildFastAgentSubagentToolFilter({
      codeModeIntegrationsEnabled: true,
    });
    expect(filter[FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool]).toBe(
      false,
    );
    expect(filter[FAST_AGENT_NATIVE_TOOL_NAMES.findIntegrationTools]).toBe(
      true,
    );
    expect(filter['*']).toBe(true);
  });

  it('offers list_repositories to the Fast parent on every surface but not to subagents', () => {
    const name = FAST_AGENT_NATIVE_TOOL_NAMES.listRepositories;
    expect(buildFastAgentToolFilter([], { surface: 'web' })[name]).toBe(true);
    expect(buildFastAgentToolFilter([], { surface: 'slack' })[name]).toBe(true);
    expect(FAST_AGENT_SUBAGENT_TOOL_FILTER[name]).toBe(false);
    expect(getFastAgentNativeAcpKind(name)).toBe(ACP_TOOL_KINDS.list);
  });

  it.each([
    [
      FAST_AGENT_NATIVE_TOOL_NAMES.prepareServiceCredential,
      ACP_TOOL_KINDS.tool,
    ],
    [FAST_AGENT_NATIVE_TOOL_NAMES.listServiceCredentials, ACP_TOOL_KINDS.list],
  ])('temporarily hides %s from every Fast surface', (name, kind) => {
    expect(FAST_AGENT_NATIVE_TOOL_FILTER[name]).toBe(false);
    expect(buildFastAgentToolFilter([], { surface: 'web' })[name]).toBe(false);
    expect(buildFastAgentToolFilter([], { surface: 'slack' })[name]).toBe(
      false,
    );
    expect(
      buildFastAgentToolFilter([], {
        surface: 'web',
        serviceCredentialToolsEnabled: true,
      })[name],
    ).toBe(true);
    expect(FAST_AGENT_SUBAGENT_TOOL_FILTER[name]).toBe(false);
    expect(getFastAgentNativeAcpKind(name)).toBe(kind);
  });

  it('can expose existing grants without allowing a platform event to prepare one', () => {
    const filter = buildFastAgentToolFilter([], {
      surface: 'web',
      serviceCredentialToolsEnabled: true,
      serviceCredentialPrepareEnabled: false,
    });
    expect(filter[FAST_AGENT_NATIVE_TOOL_NAMES.listServiceCredentials]).toBe(
      true,
    );
    expect(filter[FAST_AGENT_NATIVE_TOOL_NAMES.prepareServiceCredential]).toBe(
      false,
    );
  });

  it('exposes remote MCP creation only when the caller enables the admin tool', () => {
    expect(
      buildFastAgentToolFilter([], {})[
        FAST_AGENT_NATIVE_TOOL_NAMES.addRemoteMcp
      ],
    ).toBe(false);
    expect(
      buildFastAgentToolFilter([], { addRemoteMcpEnabled: true })[
        FAST_AGENT_NATIVE_TOOL_NAMES.addRemoteMcp
      ],
    ).toBe(true);
    expect(
      FAST_AGENT_SUBAGENT_TOOL_FILTER[
        FAST_AGENT_NATIVE_TOOL_NAMES.addRemoteMcp
      ],
    ).toBe(false);
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
    [FAST_AGENT_NATIVE_TOOL_NAMES.reportPlatformIssue, ACP_TOOL_KINDS.tool],
  ])('maps %s to %s', (name, expected) => {
    expect(getFastAgentNativeAcpKind(name)).toBe(expected);
  });
});
