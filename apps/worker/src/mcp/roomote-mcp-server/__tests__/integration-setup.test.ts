import { INTEGRATION_SETUP_CONTENT } from '../integration-setup.js';

describe('integration setup guide', () => {
  it('mentions feature requests for unsupported built-in integrations', () => {
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'They can send the team a feature request, and the team acts on those quickly.',
    );
  });

  it('documents both feature request submission paths', () => {
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'Use the shared Slack channel with the Roomote team, if they have one.',
    );
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'Or click the Lightbulb / Feature Request action in the web navigation.',
    );
  });

  it('documents the org-scoped Pylon setup flow', () => {
    expect(INTEGRATION_SETUP_CONTENT).toContain('# Pylon');
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'That admin connects Pylon once for the workspace via OAuth.',
    );
  });

  it('documents the org-scoped Jira setup flow', () => {
    expect(INTEGRATION_SETUP_CONTENT).toContain('# Jira');
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'That admin connects Jira once for the workspace via OAuth.',
    );
  });

  it('documents the user-scoped read-only monday.com setup flow', () => {
    expect(INTEGRATION_SETUP_CONTENT).toContain('# monday.com');
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'Each user connects their own monday.com account via OAuth.',
    );
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'The built-in connection is read-only.',
    );
  });

  it('documents the Sentry MCP-first setup flow', () => {
    expect(INTEGRATION_SETUP_CONTENT).toContain('# Sentry');
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'That admin connects Sentry once for the workspace via OAuth.',
    );
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'scheduled Sentry triage automation uses the same read-only MCP connection.',
    );
  });

  it('documents the admin-managed Vercel setup flow', () => {
    expect(INTEGRATION_SETUP_CONTENT).toContain('# Vercel');
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'That admin connects Vercel once for the workspace with a Vercel access token.',
    );
  });

  it('documents the admin-managed Grafana setup flow', () => {
    expect(INTEGRATION_SETUP_CONTENT).toContain('# Grafana');
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'That admin connects Grafana once for the workspace with a Grafana URL and service account token.',
    );
  });

  it('documents the org-scoped Supermemory setup flow', () => {
    expect(INTEGRATION_SETUP_CONTENT).toContain('# Supermemory');
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'That admin connects Supermemory once for the workspace via OAuth.',
    );
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'anything I save is visible to everyone in the workspace.',
    );
  });

  it('documents the deployment-scoped Zero setup flow', () => {
    expect(INTEGRATION_SETUP_CONTENT).toContain('# Zero');
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'That operator connects Zero once for the workspace via OAuth.',
    );
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'Only after Zero is enabled for the deployment do I install the zero CLI',
    );
  });

  it('documents Resend tool safety defaults', () => {
    expect(INTEGRATION_SETUP_CONTENT).toContain('# Resend');
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'That admin connects Resend once for the workspace via OAuth.',
    );
    expect(INTEGRATION_SETUP_CONTENT).toContain(
      'Email sending, credential creation, scheduled-send changes, automation mutations and triggers, and contact mutations are disabled',
    );
  });
});
