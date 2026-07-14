import { describe, expect, it } from 'vitest';

import {
  ENVIRONMENT_SETUP_SKILL_INVOCATION,
  buildCreateEnvironmentDefinitionPrompt,
  isEnvironmentSetupTaskPrompt,
} from './environment-definition-tasks';

describe('isEnvironmentSetupTaskPrompt', () => {
  it('matches the bare skill invocation', () => {
    expect(isEnvironmentSetupTaskPrompt('$environment-setup')).toBe(true);
  });

  it('matches the invocation followed by the prompt body', () => {
    expect(
      isEnvironmentSetupTaskPrompt('$environment-setup\n\nSet up an env'),
    ).toBe(true);
  });

  it('tolerates leading whitespace', () => {
    expect(isEnvironmentSetupTaskPrompt('  \n$environment-setup\nbody')).toBe(
      true,
    );
  });

  it('matches the prompt produced by the create-environment builder', () => {
    expect(
      isEnvironmentSetupTaskPrompt(
        buildCreateEnvironmentDefinitionPrompt(['owner/repo']),
      ),
    ).toBe(true);
  });

  it('rejects other skill invocations sharing the prefix', () => {
    expect(
      isEnvironmentSetupTaskPrompt(`${ENVIRONMENT_SETUP_SKILL_INVOCATION}-v2`),
    ).toBe(false);
  });

  it('rejects prompts that mention the invocation later in the text', () => {
    expect(
      isEnvironmentSetupTaskPrompt('Please run $environment-setup for me'),
    ).toBe(false);
  });

  it('rejects missing prompts', () => {
    expect(isEnvironmentSetupTaskPrompt(undefined)).toBe(false);
    expect(isEnvironmentSetupTaskPrompt(null)).toBe(false);
    expect(isEnvironmentSetupTaskPrompt('')).toBe(false);
  });
});
