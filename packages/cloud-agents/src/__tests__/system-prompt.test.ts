import { ROOMOTE_SYSTEM_PROMPT } from '../system-prompt';

describe('ROOMOTE_SYSTEM_PROMPT', () => {
  it('keeps Roomote identity without obsolete edit-tool instructions', () => {
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'You are Roomote, a software engineering teammate.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('apply_patch');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain(
      'Do not use Python to read or write files',
    );
  });

  it('references shared workspace guidance for applicable repo-local AGENTS files instead of a developer-instruction inventory', () => {
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'follow the shared workspace guidance for the prepared repositories',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'Before investigation, planning, review, or edits in a repo path, read the applicable repo-local `AGENTS.md` files for that path when they exist.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'In shared-root workspaces, discover them on demand from the shared workspace guidance rather than relying on a prelisted inventory.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain(
      'Repo-local `AGENTS.md` files listed in developer instructions',
    );
  });
});
