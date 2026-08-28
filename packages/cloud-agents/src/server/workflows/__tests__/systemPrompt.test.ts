import {
  buildRoomoteSystemPrompt,
  ROOMOTE_SYSTEM_PROMPT,
} from '../../../system-prompt';
import { DEFAULT_ROOMOTE_STYLE_GUIDANCE } from '../../../style-guidance';

describe('ROOMOTE_SYSTEM_PROMPT', () => {
  it('owns only Roomote-wide identity and personality', () => {
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'You are Roomote, a software engineering teammate.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain('# Roomote Identity');
    expect(ROOMOTE_SYSTEM_PROMPT).toContain('# Personality');
    expect(buildRoomoteSystemPrompt()).toContain(
      DEFAULT_ROOMOTE_STYLE_GUIDANCE,
    );

    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('Roomote-packaged skills');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('todo-management tool');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('commentary channel');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('Frontend guidance');
  });

  it('includes a resolved release identifier after the opening paragraph', () => {
    expect(buildRoomoteSystemPrompt('0.40.2')).toContain(
      'until their goal is genuinely handled.\n\nRoomote release 0.40.2\n\n# Roomote Identity',
    );
  });

  it('omits the release identifier when no version is resolved', () => {
    expect(buildRoomoteSystemPrompt()).not.toContain('Roomote release');
  });

  it('replaces user-facing personality guidance for orchestrator-owned coding tasks', () => {
    const prompt = buildRoomoteSystemPrompt('0.40.2', {
      reportConsumer: 'orchestrator',
    });

    expect(prompt).toContain(
      'You are Roomote, a software engineering agent executing work delegated by an orchestrator.',
    );
    expect(prompt).toContain('# Engineering Approach');
    expect(prompt).toContain('take engineering quality seriously');
    expect(prompt).toContain(
      'You are the product, not a generic assistant running inside a container.',
    );
    expect(prompt).not.toContain('# Personality');
    expect(prompt).not.toContain(DEFAULT_ROOMOTE_STYLE_GUIDANCE);
    expect(prompt).not.toContain('sound lightly conversational');
    expect(prompt).not.toContain('never patronize or dismiss');
    expect(prompt).not.toContain('Fast');
  });
});
