import {
  getGitHubLinkedWorkItemsFromClosingIssues,
  mergeLinkedWorkItems,
  renderLinkedWorkItemsSection,
} from '../pr-linked-work-items';

describe('pr linked work items', () => {
  it('renders provider-specific references into a single PR section', () => {
    expect(
      renderLinkedWorkItemsSection([
        {
          provider: 'github',
          identifier: '123',
          repository: 'owner/repo',
        },
        {
          provider: 'linear',
          identifier: 'ENG-123',
        },
        {
          provider: 'jira',
          identifier: 'ABC-123',
        },
        {
          provider: 'asana',
          identifier: '12001234567890',
          url: 'https://app.asana.com/0/12001234567890/12001234567891',
        },
      ]),
    ).toBe(
      [
        '## Linked work items',
        '',
        'Closes owner/repo#123',
        'Closes ENG-123',
        'Refs ABC-123',
        'Task: https://app.asana.com/0/12001234567890/12001234567891',
      ].join('\n'),
    );
  });

  it('deduplicates merged linked work items while preserving first-seen order', () => {
    expect(
      mergeLinkedWorkItems(
        [
          {
            provider: 'linear',
            identifier: 'ENG-123',
          },
        ],
        [
          {
            provider: 'linear',
            identifier: 'ENG-123',
          },
          {
            provider: 'github',
            identifier: '123',
            repository: 'owner/repo',
          },
        ],
      ),
    ).toEqual([
      {
        provider: 'linear',
        identifier: 'ENG-123',
      },
      {
        provider: 'github',
        identifier: '123',
        repository: 'owner/repo',
      },
    ]);
  });

  it('normalizes GitHub closing issues into shared linked work items', () => {
    expect(
      getGitHubLinkedWorkItemsFromClosingIssues({
        closingIssuesReferences: [
          {
            number: 456,
            url: 'https://github.com/owner/test-repo/issues/456',
          },
        ],
        fallbackRepository: 'owner/test-repo',
      }),
    ).toEqual([
      {
        provider: 'github',
        identifier: '456',
        url: 'https://github.com/owner/test-repo/issues/456',
        repository: 'owner/test-repo',
      },
    ]);
  });
});
