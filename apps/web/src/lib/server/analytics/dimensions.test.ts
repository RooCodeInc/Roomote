import {
  getTaskInitiatorDimensionValue,
  getTaskTypeDimensionValue,
} from './dimensions';

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

describe('getTaskTypeDimensionValue', () => {
  it.each([
    [
      { initiatorKind: 'user' as const, initiatorAutomation: null },
      { key: 'Manual', label: 'Manual Task' },
    ],
    [
      { initiatorKind: null, initiatorAutomation: null },
      { key: 'Unknown', label: 'Unknown Task' },
    ],
    [
      {
        initiatorKind: 'automation' as const,
        initiatorAutomation: 'automation',
      },
      { key: 'automation:automation', label: 'Automation' },
    ],
    [
      {
        initiatorKind: 'automation' as const,
        initiatorAutomation: 'pr_review',
      },
      { key: 'automation:pr_review', label: 'PR Review Task' },
    ],
  ])('formats %o as %o', (task, dimension) => {
    expect(getTaskTypeDimensionValue(task)).toEqual(dimension);
  });
});
