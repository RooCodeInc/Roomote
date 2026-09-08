import { buildFastAgentSystemPrompt } from '../../fast-agent/fast-agent-prompt';
import { INTEGRATION_CONNECTION_GUIDANCE } from '../../integration-connection-guidance';
import { standardTask } from '../standardTask';

// Assembly contracts, not model-response behavior evaluations.
describe.each([
  [
    'Standard',
    standardTask({ description: 'Connect to X', repo: 'example/repo' })
      .harnessInstructions,
  ],
  ['Fast', buildFastAgentSystemPrompt({ availableEnvironments: [] })],
])('%s integration connection guidance', (_mode, prompt) => {
  it('includes the shared connection contract exactly once, even without integrations', () => {
    expect(prompt.split(INTEGRATION_CONNECTION_GUIDANCE)).toHaveLength(2);
  });

  it.each([
    [
      'native-first preparation',
      '`prepare_integration_connection` tool with only the nonsecret provider name',
    ],
    ['human-friendly setup', 'the user does not need to know MCP terminology'],
    ['secure handoff', 'share the returned secure setup link'],
    [
      'consent and authorization',
      'An authorized human must review and consent in Settings',
    ],
    [
      'credential safety',
      'Never solicit credentials in chat or pass credentials in tool arguments',
    ],
    [
      'remote URL safety',
      'Credentials and remote service URLs belong only in secure Settings',
    ],
    [
      'unsupported services',
      'An API-only service without a compatible remote MCP server is unsupported',
    ],
    [
      'no invented infrastructure',
      'Never invent an endpoint, build an API adapter, or offer server hosting',
    ],
    [
      'no premature success',
      '`setup_required`, a saved configuration, and pending authorization are not verified connected',
    ],
    [
      'post-setup verification',
      'use existing `find_integration_tools` discovery',
    ],
    ['permitted tools', 'available, permitted tools before claiming success'],
    [
      'cached evidence limits',
      'cached listing alone does not prove live access',
    ],
    ['no invented refresh', 'Discovery has no force-refresh parameter'],
    ['Standard catalog limit', 'a newly added server may require a new task'],
    [
      'Fast cache limit',
      'Fast reloads its catalog on later turns but may serve cached tools',
    ],
    ['no bypass', 'Never bypass Settings authorization or tool restrictions'],
  ])('preserves %s', (_contract, text) => {
    expect(prompt).toContain(text);
  });
});
