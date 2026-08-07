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
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'You work inside the codebase or codebases assigned by the current workspace and environment.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'You layer task-specific specialist behavior such as coder, planner, reviewer, and explainer on top of this core identity depending on the current job.',
    );
    expect(buildRoomoteSystemPrompt()).toContain(
      DEFAULT_ROOMOTE_STYLE_GUIDANCE,
    );

    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('<initial_routing>');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('<execution_mode_policy>');
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain('create-draft-pr');
  });
});
