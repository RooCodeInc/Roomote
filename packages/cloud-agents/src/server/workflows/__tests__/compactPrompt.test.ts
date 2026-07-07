import { ROOMOTE_COMPACT_PROMPT } from '../../../compact-prompt';

describe('ROOMOTE_COMPACT_PROMPT', () => {
  it('asks the compaction handoff to preserve workflow skill reload context', () => {
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'name each skill that must be reloaded on resume before continuing',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'Include only the skills and `AGENTS.md` files that are still required for the immediate next step after resume',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'Exclude anything that was read earlier in the task but is no longer active, was superseded by a later workflow phase, or only mattered to already-completed work',
    );
  });

  it('asks the compaction handoff to preserve exact AGENTS reload paths without broad reload-everything wording', () => {
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'exact `AGENTS.md` paths that were actually read or governed the current work',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'Do not tell the next model to reload every `AGENTS.md` in the workspace',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'the first and only allowed actions after resume should be rereading the exact skills and `AGENTS.md` files named in that reload set before any other action',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'Do not include completed, superseded, or no-longer-relevant earlier-phase skills or `AGENTS.md` files in that reload set',
    );
  });

  it('uses literal XML-style tags in the prompt structure', () => {
    expect(ROOMOTE_COMPACT_PROMPT).toContain('<analysis>');
    expect(ROOMOTE_COMPACT_PROMPT).toContain('<summary>');
    expect(ROOMOTE_COMPACT_PROMPT).not.toContain('&lt;analysis&gt;');
  });
});
