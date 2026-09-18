import {
  buildRoomoteSystemPrompt,
  ROOMOTE_SYSTEM_PROMPT,
} from '../system-prompt';

describe('ROOMOTE_SYSTEM_PROMPT', () => {
  it('keeps Roomote identity without generic coding-agent policy', () => {
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'You are Roomote, a software engineering teammate.',
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
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'treat session, task, home, integration, automation, memory, skill, and similar product feature nouns as lowercase common nouns',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'Never expose internal names such as "Fast mode" or "Fast session"',
    );
  });

  it('keeps nomenclature guidance in orchestrator-owned coding tasks', () => {
    const prompt = buildRoomoteSystemPrompt(undefined, {
      reportConsumer: 'orchestrator',
    });

    expect(prompt).toContain(
      'treat session, task, home, integration, automation, memory, skill, and similar product feature nouns as lowercase common nouns',
    );
  });

  it('tells private tasks to get owner approval before external actions', () => {
    const prompt = buildRoomoteSystemPrompt(undefined, { privacy: 'private' });

    expect(prompt).toContain('# Private Session');
    expect(prompt).toContain('You keep your full tools and permissions.');
    expect(prompt).toContain("get the owner's explicit approval");
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('Private Session');
  });
});
