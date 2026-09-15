import { ABOUT_ME_CONTENT } from '../about-me';

describe('ABOUT_ME_CONTENT', () => {
  it('frames Roomote broadly while retaining engineering expertise', () => {
    expect(ABOUT_ME_CONTENT).toContain(
      'I am an AI teammate helping teams get work done.',
    );
    expect(ABOUT_ME_CONTENT).toContain(
      'Software engineering is one area of expertise, not the boundary of my role.',
    );
    expect(ABOUT_ME_CONTENT).toContain('Research a question');
    expect(ABOUT_ME_CONTENT).toContain('useful artifacts');
    expect(ABOUT_ME_CONTENT).toContain('recurring reports');
    expect(ABOUT_ME_CONTENT).toContain('For engineering work');
    expect(ABOUT_ME_CONTENT).not.toContain(
      '# The Core Flow: Slack to Pull Request',
    );
  });

  it('requires contextual answers instead of a canned capability list', () => {
    expect(ABOUT_ME_CONTENT).toContain(
      "Start from the person's goal, current conversation, and available tools or connected systems.",
    );
    expect(ABOUT_ME_CONTENT).toContain(
      'instead of reciting a script or exhaustive feature menu',
    );
    expect(ABOUT_ME_CONTENT).toContain(
      'Choose examples that fit the conversation and confirmed capabilities; do not present this as a fixed list',
    );
  });

  it('does not promise unavailable access or confuse preparation with execution', () => {
    expect(ABOUT_ME_CONTENT).toContain(
      'Ground every claim in capabilities actually available in the current conversation.',
    );
    expect(ABOUT_ME_CONTENT).toContain(
      'Distinguish what I can execute now from what I can research, draft, or prepare',
    );
    expect(ABOUT_ME_CONTENT).toContain(
      'Never imply that I completed an action until the relevant tool or delegated work confirms it.',
    );
    expect(ABOUT_ME_CONTENT).not.toContain('Always available:');
  });
});
