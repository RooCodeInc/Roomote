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

  it('defers only scheduling schemas when the pilot is enabled', () => {
    const baseline = buildFastAgentToolFilter(['roomote']);
    const pilot = buildFastAgentToolFilter(['roomote'], {
      schedulingProgressiveDisclosureEnabled: true,
    });

    expect(baseline[FAST_AGENT_NATIVE_TOOL_NAMES.manageWakeups]).toBe(true);
    expect(baseline.roomote_manage_custom_automations).toBeUndefined();
    expect(pilot[FAST_AGENT_NATIVE_TOOL_NAMES.manageWakeups]).toBe(false);
    expect(pilot.roomote_manage_custom_automations).toBe(false);
    expect(pilot['roomote_*']).toBe(true);
    expect(pilot[FAST_AGENT_NATIVE_TOOL_NAMES.findIntegrationTools]).toBe(true);
    expect(pilot[FAST_AGENT_NATIVE_TOOL_NAMES.callIntegrationTool]).toBe(true);
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
      'To get started, I need access to your source code.',
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
    expect(prompt).toContain(
      'the administrator is free to start something new or explore the app while I work',
    );
    expect(prompt).toContain(
      'do not imply that they need to wait in or remain on the setup session',
    );
    expect(prompt).toContain('<setup_snapshot>');
    expect(prompt).toContain('request_user_input');
    expect(prompt).toContain('setup_starter_tasks');
    expect(prompt).toContain('launch_task');
    expect(prompt).toContain(
      'The renderer owns presentation of trusted setup controls, but some controls require an explicit tool call from you',
    );
    expect(prompt).toContain(
      'Keep those controls separate from my side of the conversation',
    );
    expect(prompt).toContain(
      'Never name, locate, or instruct the user to interact with UI elements',
    );
    expect(prompt).toContain(
      "state only the user's goal, the capability I need, the outcome that changed, or the decision the user needs to make",
    );
    expect(prompt).toContain(
      'Launch is deferred until the setup snapshot says',
    );
    expect(prompt).toContain(
      'I need a workspace where I can run the work you selected',
    );
    expect(prompt).toContain('Starter work is optional');
    expect(prompt).toContain(
      'call `request_user_input` with exactly `{ preset: "setup_starter_tasks" }`',
    );
    expect(prompt).toContain('the server emits a starter-request setup event');
    expect(prompt).toContain(
      'Do not send a closeout first: that tool call creates the user-visible first-work control and is the terminal response for the turn',
    );
    expect(prompt).toContain(
      'Do not replace the tool call with prose asking the user to choose',
    );
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

  it('keeps discovery optional, ordered, resumable, and server-resolved', () => {
    const prompt = buildFastAgentSystemPrompt({
      ...baseInput,
      setupSession: true,
    });
    for (const rule of [
      'Integration discovery is optional and never gates setup completion',
      'documents, monitoring, and project-tracking',
      'those existing provider flows are unaffected',
      'Do not ask provider-configuration questions in this optional discovery',
      'integrationDiscovery.categories',
      'setup-tools-<id>',
      'Offer skipping early',
      'already supplied in prose',
      'setupIntegrationAnswers',
      'keyed by category IDs (not question IDs)',
      'server exact-matches its catalog',
      'Keep going records durable discovery completion',
      'Suggest only eligible supported tools the user actually said they use',
      'without showing an empty card',
      'no need to fill missing answers',
      'All asynchronous setup events must preserve active discovery',
      'Never emit the starter preset until discovery is completed',
      'Existing starter selection or completed old setup means no restart',
      'answeredCategoryIds',
      'matchedIntegrationIds',
      'unsupportedTools',
    ])
      expect(prompt).toContain(rule);
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
    expect(setupEvent).toContain(
      'For a starter-request event, call `request_user_input` exactly once',
    );
    expect(setupEvent).toContain(
      'If any selected task started, say that the started work will continue while the user starts something new or explores the app',
    );

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
