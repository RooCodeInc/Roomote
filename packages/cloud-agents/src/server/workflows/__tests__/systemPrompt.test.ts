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
});
