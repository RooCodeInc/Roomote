import { describe, expect, it } from 'vitest';

import {
  CONTROL_PLANE_ENV_VAR_NAMES,
  SOURCE_CONTROL_SECRET_ENV_VAR_NAMES,
} from './control-plane-env-vars';

describe('CONTROL_PLANE_ENV_VAR_NAMES', () => {
  it('includes provider, integration, and instance secrets', () => {
    for (const name of [
      'MODAL_TOKEN_SECRET',
      'E2B_API_KEY',
      'R_GITHUB_APP_PRIVATE_KEY',
      'R_GITHUB_WEBHOOK_SECRET',
      'GITLAB_WEBHOOK_SECRET',
      'GITLAB_CLIENT_SECRET',
      'R_MICROSOFT_CLIENT_SECRET',
      'R_SLACK_SIGNING_SECRET',
      'R_TEAMS_BOT_APP_PASSWORD',
      'R_TELEGRAM_BOT_TOKEN',
      'R_LINEAR_CLIENT_SECRET',
      'ENCRYPTION_KEY',
      'JOB_AUTH_PRIVATE_KEY',
      'DASHBOARD_PASSWORD',
      'DATABASE_URL',
      'S3_SECRET_ACCESS_KEY',
      'ROOMOTE_CLOUD_ENABLED',
      'ROOMOTE_CLOUD_DEPLOYMENT_TOKEN',
      'ROOMOTE_CLOUD_DEPLOYMENT_ID',
      'ROOMOTE_CLOUD_INTEGRATION_SECRET',
    ]) {
      expect(CONTROL_PLANE_ENV_VAR_NAMES.has(name)).toBe(true);
    }
  });

  it('includes non-secret provider identifiers for defense-in-depth', () => {
    for (const name of [
      'R_GITHUB_APP_ID',
      'R_GITHUB_CLIENT_ID',
      'GITLAB_CLIENT_ID',
      'SLACK_APP_ID',
    ]) {
      expect(CONTROL_PLANE_ENV_VAR_NAMES.has(name)).toBe(true);
    }
  });

  it('excludes per-repo source-control access tokens', () => {
    for (const name of [
      'GITHUB_TOKEN',
      'GITLAB_TOKEN',
      'GITEA_TOKEN',
      'ADO_TOKEN',
    ]) {
      expect(CONTROL_PLANE_ENV_VAR_NAMES.has(name)).toBe(false);
      expect(SOURCE_CONTROL_SECRET_ENV_VAR_NAMES.has(name)).toBe(false);
    }
  });

  it('excludes model-provider API keys the agent needs', () => {
    for (const name of [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
    ]) {
      expect(CONTROL_PLANE_ENV_VAR_NAMES.has(name)).toBe(false);
    }
  });
});
