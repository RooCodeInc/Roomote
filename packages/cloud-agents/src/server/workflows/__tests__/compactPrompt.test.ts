import { ROOMOTE_COMPACT_PROMPT } from '../../../compact-prompt';

describe('ROOMOTE_COMPACT_PROMPT', () => {
  it('requests an operational handoff without exhaustive reconstruction or analysis output', () => {
    expect(ROOMOTE_COMPACT_PROMPT).toContain('concise operational handoff');
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'Output only the handoff inside <summary> and </summary>',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'omit obsolete history, routine tool output',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'Prefer exact paths, symbols, commands, and artifact references',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'Do not impose a fixed length budget',
    );
    expect(ROOMOTE_COMPACT_PROMPT).not.toMatch(
      /<analysis>|&lt;analysis&gt;|All User Messages|full code snippets|Chronologically analyze/,
    );
  });

  it('preserves explicit user intent, corrections, scoped authority, and decision rationale', () => {
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'acceptance criteria, explicit user requests, corrections',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain('scoped approvals or denials');
    expect(ROOMOTE_COMPACT_PROMPT).toContain('Apply the latest correction');
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'do not reproduce all user messages or infer authorization',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'consequential decisions, why they were made',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'Separate established facts from hypotheses',
    );
  });

  it('preserves actual workspace, delivery, validation, and proof state without claiming pending work is done', () => {
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'implemented versus planned changes',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'dirty work authored by the user or other agents, including unknown ownership',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'preserve work not authored by this task',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'known commit, push, and PR state with exact identifiers or links',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'commands/results and artifact paths or URLs',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'passed, failed, pending, skipped, blocked, or stale evidence',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'never turn an intention, queued action, or attempted command into a completed result',
    );
  });

  it('carries unresolved obligations and gives a concrete next action after reloads', () => {
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'unfinished user requests and parent/child workflow obligations',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'validation, proof, review, delivery, reporting, and input needs',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'exact decision or external change needed to proceed',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'After the required reloads, specify the concrete next action',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'target path or command and expected result',
    );
  });

  it('limits precise skill, supporting resource, and AGENTS reloads to the immediate next step', () => {
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'active workflow, phase, execution mode, and in-flight constraints',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'Name each skill that must be reloaded on resume before continuing, its exact known path',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'supporting resource paths or sections required for the immediate next step',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'exact `AGENTS.md` paths that were actually read or governed the current work',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'For every entry, state why it is needed now',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'Exclude completed, superseded, or no-longer-relevant earlier-phase instructions',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'Do not tell the next model to reload every `AGENTS.md` in the workspace',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'or eagerly load resources for later phases',
    );
  });

  it('requires the exact reload set before any other action and blocks on unavailable instructions', () => {
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'The first and only allowed actions after resume are reloading the exact skills, supporting resources, and `AGENTS.md` files named in this reload set before any other action',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'Do not invent paths; flag any missing required path as a reload blocker',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'If a required reload is unavailable, report the blocker rather than continuing without it',
    );
    expect(ROOMOTE_COMPACT_PROMPT).toContain(
      'The summary is not a substitute for those instructions',
    );
  });
});
