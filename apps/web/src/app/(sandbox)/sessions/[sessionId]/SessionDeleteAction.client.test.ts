import { SESSION_DELETION_DESCRIPTION } from './SessionDeleteAction';

describe('session deletion confirmation', () => {
  it('describes the cascade without promising complete forgetting', () => {
    expect(SESSION_DELETION_DESCRIPTION).toContain(
      'associated tasks and artifacts',
    );
    expect(SESSION_DELETION_DESCRIPTION).toContain('first stops active tasks');
    expect(SESSION_DELETION_DESCRIPTION).toContain(
      'Brain memories saved directly from them',
    );
    expect(SESSION_DELETION_DESCRIPTION).toContain(
      'does not remove independently collected Slack or pull request content',
    );
    expect(SESSION_DELETION_DESCRIPTION).toContain('broader summaries');
  });
});
