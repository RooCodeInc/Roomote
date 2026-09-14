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
    expect(prompt).toContain("Hi, I'm Roomote");
    expect(prompt).toContain(
      'I can start by connecting to your source code, or we can skip that and focus on your other tools.',
    );
    expect(prompt).toContain(
      'always refer to Roomote in the first person: use "I", "me", and "my"',
    );
    expect(prompt).toContain(
      "use ordinary language centered on the user's action and outcome",
    );
    expect(prompt).toContain('Your repositories are ready');
    expect(prompt).toContain("Describe launched work in the user's terms");
    expect(prompt).toContain('<setup_snapshot>');
    expect(prompt).toContain('request_user_input');
    expect(prompt).toContain('setup_starter_tasks');
    expect(prompt).toContain('launch_task');
    expect(prompt).toContain('The renderer owns trusted controls');
    expect(prompt).toContain(
      'Never name or locate cards, rails, dialogs, panels, buttons, presets, or setup steps',
    );
    expect(prompt).toContain(
      "state only the user's goal, the capability I need, the outcome that changed, or the decision the user needs to make",
    );
    expect(prompt).toContain(
      'I need a workspace where I can run the work you selected',
    );
    expect(prompt).toContain('offer optional source control');
    expect(prompt).toContain('use the trusted `setup_starter_tasks` preset');
    expect(prompt).not.toContain('exactly once');
    expect(prompt).not.toContain(
      'Direct the administrator to the relevant card',
    );
    expect(prompt).not.toContain('complete the source-control action card');
    expect(prompt).not.toContain(
      'direct the administrator to the sandbox action card',
    );
    expect(prompt).not.toContain('helps the user recognize the visible card');
    expect(prompt).not.toContain('launch_setup_starter_tasks');
    expect(prompt).not.toContain('update_plan');
  });

  it('keeps setup adaptive while enforcing trusted offer ordering and no-source branching', () => {
    const prompt = buildFastAgentSystemPrompt({
      ...baseInput,
      setupSession: true,
    });
    for (const rule of [
      'always offer integrations after source control is synchronized or explicitly skipped',
      'accept information supplied early',
      'Never make a setup offer in prose alone',
      'must be completed before starter work or automations are offered',
      'ordered categories as suggestions, not a questionnaire',
      'setup-tools-<id>',
      'carrying proactive prose answers by category ID',
      'completes an empty match set without browser input',
      'Do not restart answered discovery categories',
      'Without synchronized repositories, never offer starter tasks',
      'do not launch a task or ask for a sandbox',
      'attempt every selected catalog prompt',
      'Automation decisions never gate setup completion',
      'Setup state-change events are coalesced current facts',
    ])
      expect(prompt).toContain(rule);
    expect(prompt).toContain(
      'What are you working on these days? Pretty sure I can help.',
    );
    expect(prompt).not.toContain('Naturally ask about communication');
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
    expect(setupEvent).not.toContain('starter-request event');

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
