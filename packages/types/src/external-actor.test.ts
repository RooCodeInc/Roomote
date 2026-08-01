import {
  formatExternalActorLabel,
  LINEAR_AGENT_ACTOR_ID,
  normalizeExternalActorId,
} from './external-actor';

describe('external actor display', () => {
  it('normalizes fallback Linear sessions to one actor', () => {
    expect(normalizeExternalActorId('linear-session:first')).toBe(
      LINEAR_AGENT_ACTOR_ID,
    );
    expect(normalizeExternalActorId('linear-session:second')).toBe(
      LINEAR_AGENT_ACTOR_ID,
    );
    expect(
      formatExternalActorLabel({
        actorExternalId: 'linear-session:first',
        actorDisplayName: null,
      }),
    ).toBe('Linear Agent');
  });

  it('preserves identified external actors', () => {
    expect(normalizeExternalActorId('linear-user-id')).toBe('linear-user-id');
    expect(
      formatExternalActorLabel({
        actorExternalId: 'linear-user-id',
        actorDisplayName: 'Ada Lovelace',
      }),
    ).toBe('Ada Lovelace');
  });
});
