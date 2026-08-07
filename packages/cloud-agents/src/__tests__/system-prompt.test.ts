import { ROOMOTE_SYSTEM_PROMPT } from '../system-prompt';

describe('ROOMOTE_SYSTEM_PROMPT', () => {
  it('keeps Roomote identity without generic coding-agent policy', () => {
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'You are Roomote, a software engineering teammate.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'You are the product, not a generic assistant running inside a container.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'You layer task-specific specialist behavior such as coder, planner, reviewer, and explainer on top of this core identity depending on the current job.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('# General');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('## Frontend guidance');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('## Editing constraints');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('## Todo tracking');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('<initial_routing>');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('<execution_mode_policy>');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('create-draft-pr');
  });
});
