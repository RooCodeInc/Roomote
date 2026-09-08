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
    ['secure native handoff', 'share the returned secure setup link'],
    [
      'callable management',
      'Use the callable Roomote `manage_integration_connection` tool, not just setup links',
    ],
    [
      'reuse existing connections',
      'Call `list` and `inspect` to reuse existing connections and their returned integration IDs before `configure`',
    ],
    [
      'native supported scope',
      'Native `configure`, `inspect`, and `request_auth` only prepare that flow',
    ],
    [
      'native unsupported operations',
      'native `test` and `permissions` are unsupported by this service',
    ],
    [
      'consent and authorization',
      'An authorized human must review and consent in Settings',
    ],
    [
      'credential safety',
      'Never solicit credentials in chat or pass credentials in tool arguments',
    ],
    [
      'verified endpoint only',
      'Ask only for the missing verified endpoint, never invent an endpoint',
    ],
    [
      'nonsecret endpoint configuration',
      'Nonsecret HTTP(S) endpoints may be passed as `url`, without credentials, query, or fragment',
    ],
    [
      'server-side secret isolation',
      'Remote credentials stay isolated server-side',
    ],
    [
      'disabled preparation',
      'it saves the remote connection DISABLED, including updates, and cannot activate it',
    ],
    [
      'empty static headers need human auth',
      'empty headers mean pending secure human authentication, not anonymous access',
    ],
    [
      'target saved connection authentication',
      'Use `request_auth` with the saved integration ID',
    ],
    [
      'secure static-header handoff',
      "static-header auth targets the existing saved connection's secure Settings dialog",
    ],
    [
      'OAuth initiation',
      'OAuth returns an initiation link for that saved connection',
    ],
    [
      'resume with authenticated test',
      'After the human completes authentication, resume in the Session and call `test`',
    ],
    [
      'test does not activate',
      'A `verified` test confirms the authenticated tool-list probe, not activation',
    ],
    [
      'explicit activation policy',
      'call `permissions` with an explicit `disabledTools` list (including `[]` only when the user explicitly allows all tools) and `enabled: true`',
    ],
    [
      'fresh activation probe',
      'Activation performs a fresh probe; a failed probe leaves the connection disabled',
    ],
    [
      'permissions default disabled',
      'Without `enabled: true`, permissions saves disabled',
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
    [
      'Standard catalog limit',
      'Standard requires a new task for a newly added server',
    ],
    [
      'Fast cache limit',
      'Fast reloads new connections on the next turn, but tool lists may be cached',
    ],
    [
      'bounded authorized adapter investigation',
      'With user authorization, use existing coding ability (delegate from Fast) for a bounded investigation of a custom adapter',
    ],
    [
      'adapter prerequisites',
      'a reachable hosted endpoint, server-side isolated credentials, and validation',
    ],
    [
      'no invented platform',
      'Roomote does not ship an arbitrary adapter-generation or hosting platform',
    ],
    ['no bypass', 'Never bypass Settings authorization or tool restrictions'],
  ])('preserves %s', (_contract, text) => {
    expect(prompt).toContain(text);
  });

  it('does not retain the link-only endpoint restriction or blanket adapter refusal', () => {
    expect(prompt).not.toContain(
      'Credentials and remote service URLs belong only in secure Settings',
    );
    expect(prompt).not.toContain(
      'Never invent an endpoint, build an API adapter, or offer server hosting',
    );
    expect(prompt).not.toContain('a newly added server may require a new task');
  });
});
