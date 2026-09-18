import {
  parsePRsFromAuthoritativeToolResultOutput,
  parsePRFromOutput,
  parsePRsFromGhPrCheckoutToolResult,
  parsePRsFromGhPrCreateToolResult,
  parsePRsFromGhPrListToolResult,
  parsePRsFromText,
} from '../extract-pull-requests';

describe('parsePRFromOutput', () => {
  it('parses a bare PR URL from gh pr create output', () => {
    const output = 'https://github.com/owner/repo/pull/42\n';
    const result = parsePRFromOutput(output);

    expect(result).toEqual({
      url: 'https://github.com/owner/repo/pull/42',
      repository: 'owner/repo',
      number: 42,
    });
  });

  it('parses a PR URL without trailing newline', () => {
    const result = parsePRFromOutput(
      'https://github.com/acme/frontend/pull/100',
    );

    expect(result).toEqual({
      url: 'https://github.com/acme/frontend/pull/100',
      repository: 'acme/frontend',
      number: 100,
    });
  });

  it('handles repos with dots and hyphens', () => {
    const result = parsePRFromOutput(
      'https://github.com/vercel/next.js/pull/12345',
    );

    expect(result).toEqual({
      url: 'https://github.com/vercel/next.js/pull/12345',
      repository: 'vercel/next.js',
      number: 12345,
    });
  });

  it('extracts the first PR URL from multiline output', () => {
    const verbose = [
      'title: My PR',
      'state: OPEN',
      'url: https://github.com/owner/repo/pull/42',
    ].join('\n');

    expect(parsePRFromOutput(verbose)).toEqual({
      url: 'https://github.com/owner/repo/pull/42',
      repository: 'owner/repo',
      number: 42,
    });
  });

  it('extracts a PR URL from surrounding output text', () => {
    const output =
      'Creating pull request... https://github.com/owner/repo/pull/42';

    expect(parsePRFromOutput(output)).toEqual({
      url: 'https://github.com/owner/repo/pull/42',
      repository: 'owner/repo',
      number: 42,
    });
  });

  it('returns null for empty output', () => {
    expect(parsePRFromOutput('')).toBeNull();
  });

  it('returns null for non-GitHub URLs', () => {
    expect(
      parsePRFromOutput('https://gitlab.com/owner/repo/pull/1'),
    ).toBeNull();
  });

  it('returns null for http:// URLs (gh uses https)', () => {
    expect(parsePRFromOutput('http://github.com/owner/repo/pull/5')).toBeNull();
  });

  it('extracts the first PR URL when output contains two PR URLs', () => {
    const output = [
      'https://github.com/owner/repo/pull/1',
      'https://github.com/owner/repo/pull/2',
    ].join('\n');

    expect(parsePRFromOutput(output)).toEqual({
      url: 'https://github.com/owner/repo/pull/1',
      repository: 'owner/repo',
      number: 1,
    });
  });

  it('trims surrounding whitespace', () => {
    const result = parsePRFromOutput(
      '  https://github.com/owner/repo/pull/99  \n',
    );

    expect(result).toEqual({
      url: 'https://github.com/owner/repo/pull/99',
      repository: 'owner/repo',
      number: 99,
    });
  });

  it('parses a PR URL line prefixed by ANSI cursor control sequences', () => {
    const result = parsePRFromOutput(
      '\u001b[?25h\r\u001b[Khttps://github.com/owner/repo/pull/123\r\n',
    );

    expect(result).toEqual({
      url: 'https://github.com/owner/repo/pull/123',
      repository: 'owner/repo',
      number: 123,
    });
  });
});

describe('parsePRsFromText', () => {
  it('extracts a PR URL embedded in markdown text', () => {
    const result = parsePRsFromText(
      'Opened draft PR: `https://github.com/owner/repo/pull/77`.',
    );

    expect(result).toEqual([
      {
        url: 'https://github.com/owner/repo/pull/77',
        repository: 'owner/repo',
        number: 77,
      },
    ]);
  });

  it('extracts a PR URL with path/query/fragment suffix and normalizes it', () => {
    const result = parsePRsFromText(
      'See https://github.com/owner/repo/pull/88/files?diff=split#r1 for details.',
    );

    expect(result).toEqual([
      {
        url: 'https://github.com/owner/repo/pull/88',
        repository: 'owner/repo',
        number: 88,
      },
    ]);
  });

  it('deduplicates repeated references to the same PR', () => {
    const result = parsePRsFromText(
      [
        'https://github.com/owner/repo/pull/99',
        '[PR link](https://github.com/owner/repo/pull/99)',
      ].join('\n'),
    );

    expect(result).toEqual([
      {
        url: 'https://github.com/owner/repo/pull/99',
        repository: 'owner/repo',
        number: 99,
      },
    ]);
  });

  it('extracts multiple distinct PR links from text', () => {
    const result = parsePRsFromText(
      [
        'https://github.com/owner/repo/pull/99',
        'https://github.com/owner/repo/pull/100',
      ].join('\n'),
    );

    expect(result).toEqual([
      {
        url: 'https://github.com/owner/repo/pull/99',
        repository: 'owner/repo',
        number: 99,
      },
      {
        url: 'https://github.com/owner/repo/pull/100',
        repository: 'owner/repo',
        number: 100,
      },
    ]);
  });
});

describe('parsePRsFromGhPrCreateToolResult', () => {
  it('extracts a standalone PR URL line from gh pr create output', () => {
    const result = parsePRsFromGhPrCreateToolResult({
      command: 'cd /repo && gh pr create --draft --body-file /tmp/pr-body.md',
      output:
        'Opened by @roomote on behalf of Chris\n\nhttps://github.com/test/repo/pull/555\n',
    });

    expect(result).toEqual([
      {
        url: 'https://github.com/test/repo/pull/555',
        repository: 'test/repo',
        number: 555,
      },
    ]);
  });

  it('extracts multiple standalone PR URL lines from gh pr create output', () => {
    const result = parsePRsFromGhPrCreateToolResult({
      command: 'if true; then gh pr create --draft; fi',
      output: [
        'Created pull requests:',
        'https://github.com/test/one/pull/11',
        'https://github.com/test/two/pull/22',
      ].join('\n'),
    });

    expect(result).toEqual([
      {
        url: 'https://github.com/test/one/pull/11',
        repository: 'test/one',
        number: 11,
      },
      {
        url: 'https://github.com/test/two/pull/22',
        repository: 'test/two',
        number: 22,
      },
    ]);
  });

  it('extracts embedded PR URLs from gh pr create output', () => {
    const result = parsePRsFromGhPrCreateToolResult({
      command: 'gh pr create --draft --body-file /tmp/pr-body.md',
      output: 'Created PR: https://github.com/test/repo/pull/777',
    });

    expect(result).toEqual([
      {
        url: 'https://github.com/test/repo/pull/777',
        repository: 'test/repo',
        number: 777,
      },
    ]);
  });

  it('extracts a PR URL line from gh pr create output with ANSI spinner control bytes', () => {
    const result = parsePRsFromGhPrCreateToolResult({
      command:
        'gh pr create --draft --repo Roomote/example-app --body-file /tmp/pr-body.md',
      output:
        '\u001b[?25l\r\u001b[K\r⣾\r\u001b[K\r⣽\u001b[?25h\r\u001b[K\r\n' +
        'Creating draft pull request for feature/test into develop in Roomote/example-app\r\n' +
        '\r\n' +
        '\u001b[?25h\r\u001b[Khttps://github.com/Roomote/example-app/pull/2345\r\n',
    });

    expect(result).toEqual([
      {
        url: 'https://github.com/Roomote/example-app/pull/2345',
        repository: 'Roomote/example-app',
        number: 2345,
      },
    ]);
  });

  it('extracts a PR URL line when spinner redraw glyphs precede the final URL', () => {
    const result = parsePRsFromGhPrCreateToolResult({
      command:
        'gh pr create --draft --repo Roomote/example-app --body-file /tmp/pr-body.md',
      output:
        '\u001b[?25l\r\u001b[K\r⣾\r\u001b[K\r⣽\r\u001b[K\r⣻\u001b[?25h\r\u001b[K\r\n' +
        'Creating draft pull request for fix/first-person-slack-task-suggestions-0lxcmd2tepbt2 into develop in Roomote/example-app\r\n' +
        '\r\n' +
        '\u001b[?25l\r\u001b[K\r⣾\r\u001b[K\r⣽\r\u001b[K\r⣻\r\u001b[K\r⢿\r\u001b[K\r⡿\r\u001b[K\r⣟\r\u001b[K\r⣯\r\u001b[K\r⣷\r\u001b[K\r⣾\r\u001b[K\r⣽\r\u001b[K\r⣻\r\u001b[K\r⢿\r\u001b[K\r⡿\r\u001b[K\r⣟\r\u001b[K\r⣯\r\u001b[K\r⣷\r\u001b[K\r⣾\r\u001b[K\r⣽\r\u001b[K\r⣻\r\u001b[K\r⢿\r\u001b[K\r⡿\r\u001b[K\r⣟\r\u001b[K\r⣯\r\u001b[K\r⣷\u001b[?25h\r\u001b[Khttps://github.com/Roomote/example-app/pull/2587\r\n',
    });

    expect(result).toEqual([
      {
        url: 'https://github.com/Roomote/example-app/pull/2587',
        repository: 'Roomote/example-app',
        number: 2587,
      },
    ]);
  });

  it('does not extract standalone PR URL lines when the command did not run gh pr create', () => {
    const result = parsePRsFromGhPrCreateToolResult({
      command: 'gh pr view --json url',
      output: [
        'Opened by @roomote on behalf of Chris',
        'https://github.com/test/repo/pull/555',
      ].join('\n'),
    });

    expect(result).toEqual([]);
  });
});

describe('parsePRsFromGhPrCheckoutToolResult', () => {
  it('extracts PR identity from a successful gh pr checkout result', () => {
    const result = parsePRsFromGhPrCheckoutToolResult({
      command: 'gh pr checkout 2696 --repo Roomote/example-app',
      output: [
        "Switched to a new branch 'fix/screencast-proof-artifact-uploads-0afl6m7c0gv35'",
        "branch 'fix/screencast-proof-artifact-uploads-0afl6m7c0gv35' set up to track 'origin/fix/screencast-proof-artifact-uploads-0afl6m7c0gv35'.",
      ].join('\n'),
    });

    expect(result).toEqual([
      {
        url: 'https://github.com/Roomote/example-app/pull/2696',
        repository: 'Roomote/example-app',
        number: 2696,
      },
    ]);
  });

  it('does not extract PR info when checkout output does not show a successful branch switch', () => {
    const result = parsePRsFromGhPrCheckoutToolResult({
      command: 'gh pr checkout 2696 --repo Roomote/example-app',
      output: 'could not resolve to a pull request',
    });

    expect(result).toEqual([]);
  });

  it('does not extract PR info when the command lacks a repo flag', () => {
    const result = parsePRsFromGhPrCheckoutToolResult({
      command: 'gh pr checkout 2696',
      output: "Switched to branch 'feature/test'",
    });

    expect(result).toEqual([]);
  });

  it('falls back to the task-run repository when checkout omits --repo', () => {
    const result = parsePRsFromGhPrCheckoutToolResult({
      command: 'gh pr checkout 2696 --force',
      fallbackRepository: 'Roomote/example-app',
      output:
        "Switched to branch 'fix/screencast-proof-artifact-uploads-0afl6m7c0gv35'",
    });

    expect(result).toEqual([
      {
        url: 'https://github.com/Roomote/example-app/pull/2696',
        repository: 'Roomote/example-app',
        number: 2696,
      },
    ]);
  });

  it('does not treat the all-repositories launch target as a repository', () => {
    const result = parsePRsFromGhPrCheckoutToolResult({
      command: 'gh pr checkout 2228',
      fallbackRepository: '__all_repositories__',
      output: "Switched to branch 'feature/release-roomote-1-3-0'",
    });

    expect(result).toEqual([]);
  });

  it('prefers an explicit short repo flag over the fallback repository', () => {
    const result = parsePRsFromGhPrCheckoutToolResult({
      command: 'gh pr checkout 2696 -R other/repo --force',
      fallbackRepository: 'Roomote/example-app',
      output:
        "Switched to branch 'fix/screencast-proof-artifact-uploads-0afl6m7c0gv35'",
    });

    expect(result).toEqual([
      {
        url: 'https://github.com/other/repo/pull/2696',
        repository: 'other/repo',
        number: 2696,
      },
    ]);
  });
});

describe('parsePRsFromGhPrListToolResult', () => {
  it('extracts a branch-scoped existing PR from production gh pr list jq output', () => {
    const result = parsePRsFromGhPrListToolResult({
      command:
        'existing_pr=$(gh pr list --repo test/repo --head "feature/test" --state open --json number --jq \'.[0].number\') && if [ -n "$existing_pr" ] && [ "$existing_pr" != "null" ]; then gh pr edit "$existing_pr" --repo test/repo --title "Title" --body-file /tmp/pr-body.md; fi',
      output: '555\n',
    });

    expect(result).toEqual([
      {
        url: 'https://github.com/test/repo/pull/555',
        repository: 'test/repo',
        number: 555,
      },
    ]);
  });

  it('does not extract a PR when jq output is null', () => {
    const result = parsePRsFromGhPrListToolResult({
      command:
        'existing_pr=$(gh pr list --repo test/repo --head "feature/test" --state open --json number --jq \'.[0].number\')',
      output: 'null\n',
    });

    expect(result).toEqual([]);
  });

  it('does not extract a PR when jq output is zero', () => {
    const result = parsePRsFromGhPrListToolResult({
      command:
        'existing_pr=$(gh pr list --repo test/repo --head "feature/test" --state open --json number --jq \'.[0].number\')',
      output: '0\n',
    });

    expect(result).toEqual([]);
  });

  it('does not extract a PR when jq output is negative', () => {
    const result = parsePRsFromGhPrListToolResult({
      command:
        'existing_pr=$(gh pr list --repo test/repo --head "feature/test" --state open --json number --jq \'.[0].number\')',
      output: '-1\n',
    });

    expect(result).toEqual([]);
  });

  it('extracts a branch-scoped existing PR from gh pr list json output with url', () => {
    const result = parsePRsFromGhPrListToolResult({
      command:
        'gh pr list --repo test/repo --head "feature/test" --state open --json number,isDraft,url --limit 1',
      output: JSON.stringify([
        {
          isDraft: true,
          number: 555,
          url: 'https://github.com/test/repo/pull/555',
        },
      ]),
    });

    expect(result).toEqual([
      {
        url: 'https://github.com/test/repo/pull/555',
        repository: 'test/repo',
        number: 555,
      },
    ]);
  });

  it('does not extract PRs from non-branch-scoped gh pr list output', () => {
    const result = parsePRsFromGhPrListToolResult({
      command:
        'gh pr list --repo test/repo --state open --json number,isDraft,url',
      output: JSON.stringify([
        {
          isDraft: true,
          number: 555,
          url: 'https://github.com/test/repo/pull/555',
        },
      ]),
    });

    expect(result).toEqual([]);
  });
});

describe('parsePRsFromAuthoritativeToolResultOutput', () => {
  it('extracts a PR from a reduced delivery payload with url and headRefName only', () => {
    const result = parsePRsFromAuthoritativeToolResultOutput(
      JSON.stringify({
        headRefName: 'feature/fix-linkage',
        url: 'https://github.com/test/repo/pull/556',
      }),
    );

    expect(result).toEqual([
      {
        url: 'https://github.com/test/repo/pull/556',
        repository: 'test/repo',
        number: 556,
      },
    ]);
  });

  it('extracts a PR from the structured delivery result emitted by PR creation', () => {
    const result = parsePRsFromAuthoritativeToolResultOutput(
      JSON.stringify({
        baseRefName: 'develop',
        headRefName: 'feature/fix-linkage',
        isDraft: true,
        title: '[Fix] Link PR metadata to tasks',
        url: 'https://github.com/test/repo/pull/556',
      }),
    );

    expect(result).toEqual([
      {
        url: 'https://github.com/test/repo/pull/556',
        repository: 'test/repo',
        number: 556,
      },
    ]);
  });

  it('extracts a PR when the delivery result includes extra fields', () => {
    const result = parsePRsFromAuthoritativeToolResultOutput(
      JSON.stringify({
        baseRefName: 'develop',
        headRefName: 'feature/fix-linkage',
        isDraft: true,
        labels: ['roomote:auto-resolve-conflicts'],
        number: 556,
        title: '[Fix] Link PR metadata to tasks',
        url: 'https://github.com/test/repo/pull/556',
      }),
    );

    expect(result).toEqual([
      {
        url: 'https://github.com/test/repo/pull/556',
        repository: 'test/repo',
        number: 556,
      },
    ]);
  });

  it('extracts a PR from a production-shaped payload with ANSI noise and a trailing newline', () => {
    const result = parsePRsFromAuthoritativeToolResultOutput(
      `\u001b[32m${JSON.stringify({
        baseRefName: 'develop',
        headRefName: 'feature/fix-linkage',
        isDraft: true,
        title: '[Fix] Link PR metadata to tasks',
        url: 'https://github.com/test/repo/pull/556',
      })}\u001b[0m\n`,
    );

    expect(result).toEqual([
      {
        url: 'https://github.com/test/repo/pull/556',
        repository: 'test/repo',
        number: 556,
      },
    ]);
  });

  it('does not extract a PR from generic JSON that only happens to contain a URL', () => {
    const result = parsePRsFromAuthoritativeToolResultOutput(
      JSON.stringify({
        url: 'https://github.com/test/repo/pull/556',
      }),
    );

    expect(result).toEqual([]);
  });

  it('does not extract a PR from reduced payloads that include unsupported fields', () => {
    const result = parsePRsFromAuthoritativeToolResultOutput(
      JSON.stringify({
        headRefName: 'feature/fix-linkage',
        summary: 'PR refreshed',
        url: 'https://github.com/test/repo/pull/556',
      }),
    );

    expect(result).toEqual([]);
  });

  it('does not extract a PR from richer PR JSON meant for inspection rather than delivery', () => {
    const result = parsePRsFromAuthoritativeToolResultOutput(
      JSON.stringify({
        author: { login: 'roomote[bot]' },
        baseRefName: 'develop',
        body: 'Body',
        headRefName: 'feature/fix-linkage',
        isDraft: true,
        title: '[Fix] Link PR metadata to tasks',
        url: 'https://github.com/test/repo/pull/556',
      }),
    );

    expect(result).toEqual([]);
  });
});
