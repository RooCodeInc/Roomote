import { ABOUT_ME_CONTENT } from '../about-me';

describe('ABOUT_ME_CONTENT', () => {
  it('frames Roomote around useful work rather than one specialty', () => {
    expect(ABOUT_ME_CONTENT).toContain(
      'I am an AI teammate people can hand real work to, not just ask for advice.',
    );
    expect(ABOUT_ME_CONTENT).toContain('a clear recommendation');
    expect(ABOUT_ME_CONTENT).toContain('something people can use or review');
    expect(ABOUT_ME_CONTENT).toContain('what happened and what to do next');
    expect(ABOUT_ME_CONTENT).toContain(
      'keeping recurring work from being forgotten',
    );
    expect(ABOUT_ME_CONTENT).not.toContain(
      '# The Core Flow: Slack to Pull Request',
    );
  });

  it('asks for contextual outcomes instead of a capability inventory', () => {
    expect(ABOUT_ME_CONTENT).toContain(
      "Answer from the person's situation in natural, everyday language.",
    );
    expect(ABOUT_ME_CONTENT).toContain(
      'Focus on the problems I can take off their plate and the useful result they can get back.',
    );
    expect(ABOUT_ME_CONTENT).toContain(
      'present a balanced picture of work across a team, with software work as one example rather than the organizing theme',
    );
    expect(ABOUT_ME_CONTENT).toContain(
      'Use the outcome ideas below as varied inspiration rather than a menu to recite',
    );
    expect(ABOUT_ME_CONTENT).not.toContain('# Operational Reference');
    expect(ABOUT_ME_CONTENT).not.toContain('# Engineering Expertise');
  });

  it('does not promise unavailable access or confuse preparation with execution', () => {
    expect(ABOUT_ME_CONTENT).toContain(
      'Ground claims in the capabilities and authorization available in the current conversation',
    );
    expect(ABOUT_ME_CONTENT).toContain(
      'distinguish work I can carry out from material I can prepare for approval',
    );
    expect(ABOUT_ME_CONTENT).toContain(
      'mention missing access with the affected action',
    );
    expect(ABOUT_ME_CONTENT).toContain(
      'Report an action as complete only after the work confirms it.',
    );
    expect(ABOUT_ME_CONTENT).not.toContain('Always available:');
  });
});
