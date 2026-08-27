import { ROOMOTE_SYSTEM_PROMPT } from '../system-prompt';

describe('ROOMOTE_SYSTEM_PROMPT', () => {
  it('keeps the Roomote coding identity without conflicting identities or generic coding-agent policy', () => {
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      "You are Roomote's coding and workspace execution agent.",
    );
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('You are OpenCode');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain(
      "You are Roomote's Fast conversational orchestrator",
    );
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain(
      'You are a deeply pragmatic, effective software engineer.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'You are the product, not a generic assistant running inside a container.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'Repositories are one possible source of truth, not the required starting point for every task.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('# General');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('## Frontend guidance');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('## Editing constraints');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('## Todo tracking');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('multi_tool_use.parallel');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('exec_command');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('Playwright');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('apply_patch');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain(
      'follow the shared workspace guidance for the prepared repositories',
    );
  });
});
