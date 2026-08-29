import { describe, expect, it } from 'vitest';

import {
  buildFastAgentToolFilter,
  FAST_AGENT_NATIVE_TOOL_FILTER,
} from './fast-agent-tool-policy';
import { FAST_AGENT_NATIVE_TOOL_NAMES } from '@roomote/types';
import { buildFastAgentSystemPrompt } from './fast-agent-prompt';

describe('setup-only native tool filtering', () => {
  it('excludes setup-only tools from the default native filter', () => {
    expect(
      FAST_AGENT_NATIVE_TOOL_FILTER[
        FAST_AGENT_NATIVE_TOOL_NAMES.launchSetupStarterTasks
      ],
    ).toBeUndefined();
    expect(
      FAST_AGENT_NATIVE_TOOL_FILTER[FAST_AGENT_NATIVE_TOOL_NAMES.updatePlan],
    ).toBe(true);
    expect(
      FAST_AGENT_NATIVE_TOOL_FILTER[
        FAST_AGENT_NATIVE_TOOL_NAMES.requestUserInput
      ],
    ).toBe(true);
  });

  it('hides setup-only tools for generic sessions and exposes them for setup sessions', () => {
    const generic = buildFastAgentToolFilter(['linear'], {
      setupSession: false,
    });
    expect(
      generic[FAST_AGENT_NATIVE_TOOL_NAMES.launchSetupStarterTasks],
    ).toBeUndefined();

    const setup = buildFastAgentToolFilter(['linear'], { setupSession: true });
    expect(setup[FAST_AGENT_NATIVE_TOOL_NAMES.launchSetupStarterTasks]).toBe(
      true,
    );
    expect(generic['linear_*']).toBe(true);
  });
});

describe('setup prompt guidance and snapshot injection', () => {
  const baseInput = {
    availableEnvironments: [],
  } as Parameters<typeof buildFastAgentSystemPrompt>[0];

  it('includes agenda, side-panel, and starter-catalog guidance for setup sessions', () => {
    const prompt = buildFastAgentSystemPrompt({
      ...baseInput,
      setupSession: true,
      setupSnapshot: '{"starterCatalog":[]}',
    });

    expect(prompt).toContain('## Conversational Setup');
    expect(prompt).toContain('<setup_snapshot>');
    expect(prompt).toContain('update_plan');
    expect(prompt).toContain('request_user_input');
    expect(prompt).toContain('launch_setup_starter_tasks');
    expect(prompt).toContain('starter-task catalog');
  });

  it('omits setup sections for ordinary sessions', () => {
    const prompt = buildFastAgentSystemPrompt(baseInput);

    expect(prompt).not.toContain('## Conversational Setup');
    expect(prompt).not.toContain('<setup_snapshot>');
  });

  it('provides trusted lifecycle guidance for setup and input-response platform events', () => {
    const setupEvent = buildFastAgentSystemPrompt({
      ...baseInput,
      turnSource: 'platform_event',
      platformEventKind: 'setup',
    });
    expect(setupEvent).toContain('Setup Platform Event');
    expect(setupEvent).toContain('Reconcile the onboarding agenda');

    const inputResponseEvent = buildFastAgentSystemPrompt({
      ...baseInput,
      turnSource: 'platform_event',
      platformEventKind: 'input_response',
      platformEventVisibility: 'required',
    });
    expect(inputResponseEvent).toContain('Structured Input Response Event');
    expect(inputResponseEvent).toContain('submitted structured answers');
  });
});
