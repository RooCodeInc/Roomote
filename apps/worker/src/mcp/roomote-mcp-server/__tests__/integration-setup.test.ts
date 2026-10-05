import { INTEGRATION_SETUP_CONTENT } from '../integration-setup.js';

describe('INTEGRATION_SETUP_CONTENT', () => {
  it('sends built-in integration setup to the top-level Integrations page', () => {
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'Most built-in integrations are managed from the Integrations page in the web dashboard.',
    );
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'An admin connects Linear from the Integrations page.',
    );
    expect(INTEGRATION_SETUP_CONTENT).not.toMatch(
      /Settings\s*(>|→)\s*Integrations/,
    );
  });

  it('keeps providers configured elsewhere pointed at their own Settings pages', () => {
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'Slack is set up from Settings > Communications in the web dashboard.',
    );
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'from Settings > Source Control.',
    );
  });

  it('describes deployment-wide custom MCP servers on the Integrations page', () => {
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'Any member can add a remote custom MCP server from the Integrations page',
    );
    expect(INTEGRATION_SETUP_CONTENT).not.toContain(
      'Custom MCPs are configured per-environment, not deployment-wide.',
    );
  });
});
