import { getTaskInitiatorDimensionValue } from './dimensions';

describe('getTaskInitiatorDimensionValue', () => {
  it('groups fallback Linear session identities under a stable label', () => {
    const getValue = (actorExternalId: string) =>
      getTaskInitiatorDimensionValue({
        initiatorKind: 'user',
        initiatorUserId: null,
        initiatorAutomation: null,
        actorExternalId,
        actorDisplayName: null,
        userName: null,
        userEmail: null,
      });

    expect(getValue('linear-session:first-session')).toEqual({
      key: 'external:linear-agent',
      label: 'Linear Agent',
    });
    expect(getValue('linear-session:second-session')).toEqual({
      key: 'external:linear-agent',
      label: 'Linear Agent',
    });
  });

  it('keeps identified external users distinct', () => {
    expect(
      getTaskInitiatorDimensionValue({
        initiatorKind: 'user',
        initiatorUserId: null,
        initiatorAutomation: null,
        actorExternalId: 'linear-user-id',
        actorDisplayName: 'Ada Lovelace',
        userName: null,
        userEmail: null,
      }),
    ).toEqual({
      key: 'external:linear-user-id',
      label: 'Ada Lovelace',
    });
  });
});
