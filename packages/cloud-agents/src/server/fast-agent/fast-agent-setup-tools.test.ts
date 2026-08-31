import { describe, expect, it } from 'vitest';

import {
  buildFastAgentToolFilter,
  FAST_AGENT_NATIVE_TOOL_FILTER,
} from './fast-agent-tool-policy';
import { FAST_AGENT_NATIVE_TOOL_NAMES } from '@roomote/types';
import { buildFastAgentSystemPrompt } from './fast-agent-prompt';

describe('Fast structured input tool filtering', () => {
  it('keeps request_user_input generic without setup-only launch tools', () => {
    expect(
      FAST_AGENT_NATIVE_TOOL_FILTER[
        FAST_AGENT_NATIVE_TOOL_NAMES.requestUserInput
      ],
    ).toBe(true);
  });

  it('keeps integration tools alongside the generic native catalog', () => {
    const generic = buildFastAgentToolFilter(['linear']);
    expect(generic['linear_*']).toBe(true);
  });

  it('limits structured input to web Sessions', () => {
    expect(
      buildFastAgentToolFilter([], { surface: 'slack' })[
        FAST_AGENT_NATIVE_TOOL_NAMES.requestUserInput
      ],
    ).toBe(false);
    expect(
      buildFastAgentToolFilter([], { surface: 'web' })[
        FAST_AGENT_NATIVE_TOOL_NAMES.requestUserInput
      ],
    ).toBe(true);
  });
});

describe('setup prompt guidance and snapshot injection', () => {
  const baseInput = {
    availableEnvironments: [],
  } as Parameters<typeof buildFastAgentSystemPrompt>[0];

  it('includes first-interaction and plain-language guidance for setup sessions', () => {
    const prompt = buildFastAgentSystemPrompt({
      ...baseInput,
      setupSession: true,
      setupSnapshot: '{"starterCatalog":[]}',
    });

    expect(prompt).toContain('## Conversational Setup');
    expect(prompt).toContain('## First Roomote Interaction');
    expect(prompt).toContain(
      "This is often the user's first interaction with Roomote",
    );
    expect(prompt).toContain(
      'always refer to Roomote in the first person: use "I", "me", and "my"',
    );
    expect(prompt).toContain(
      "use ordinary language centered on the user's action and outcome",
    );
    expect(prompt).toContain('Your repositories are ready');
    expect(prompt).toContain(
      "I'm looking for flaky tests and fixing the ones causing the most trouble.",
    );
    expect(prompt).toContain('<setup_snapshot>');
    expect(prompt).toContain('request_user_input');
    expect(prompt).toContain('setup_starter_tasks');
    expect(prompt).toContain('launch_task');
    expect(prompt).toContain(
      'Never ask the administrator to configure the sandbox before collecting first-work selection',
    );
    expect(prompt).toContain(
      'Launch is deferred until the setup snapshot says',
    );
    expect(prompt).toContain('inline sandbox card');
    expect(prompt).not.toContain('launch_setup_starter_tasks');
    expect(prompt).not.toContain('update_plan');
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
    expect(setupEvent).toContain('Reconcile them against the setup snapshot');

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
