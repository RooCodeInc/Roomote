import {
  enrichGitHubMergeAnnouncerEvent,
  normalizeAdoPush,
  normalizeBitbucketPush,
  normalizeGiteaPush,
  normalizeGitHubPush,
  normalizeGitLabPush,
  extractEligiblePullRequestImages,
} from '../merge-announcer-push';
import { adoPushWebhookSchema } from '../ado/types';
import { bitbucketPushWebhookSchema } from '../bitbucket/types';
import { giteaPushWebhookSchema } from '../gitea/types';
import { gitLabPushWebhookSchema } from '../gitlab/types';

describe('Merge announcer push normalization', () => {
  it('normalizes GitHub commit and pusher metadata', () => {
    expect(
      normalizeGitHubPush({
        ref: 'refs/heads/main',
        compare: 'https://github.com/acme/widgets/compare/a...b',
        size: 1,
        pusher: { name: 'alice' },
        sender: { login: 'alice-fallback' },
        repository: {
          id: 1,
          full_name: 'acme/widgets',
          html_url: 'https://github.com/acme/widgets',
        },
        commits: [
          {
            id: 'abc',
            message: 'Ship widget',
            author: { name: 'Bob', username: 'bob' },
          },
        ],
      }),
    ).toMatchObject({
      provider: 'github',
      ref: 'refs/heads/main',
      pusher: 'alice',
      repository: { externalId: '1', host: 'github.com' },
      commits: [{ id: 'abc', author: { username: 'bob' } }],
    });
  });

  it('extracts Markdown and HTML images in deterministic fallback order', async () => {
    await expect(
      extractEligiblePullRequestImages(
        `
![Architecture](https://user-images.githubusercontent.com/1/architecture.png)
<img src="https://github.com/user-attachments/assets/product-preview" alt="Product screenshot after save">
`,
        async () => 'image/png',
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'image-1',
        url: 'https://github.com/user-attachments/assets/product-preview',
        altText: 'Product screenshot after save',
        surroundingText: expect.stringContaining('Architecture'),
      }),
      expect.objectContaining({
        id: 'image-2',
        url: 'https://user-images.githubusercontent.com/1/architecture.png',
        altText: 'Architecture',
      }),
    ]);
  });

  it('extracts an anonymously fetchable Markdown image', async () => {
    await expect(
      extractEligiblePullRequestImages(
        '![Updated settings](https://user-images.githubusercontent.com/1/settings.png)',
        async () => 'image/png',
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'image-1',
        url: 'https://user-images.githubusercontent.com/1/settings.png',
        altText: 'Updated settings',
      }),
    ]);
  });

  it.each(['png', 'jpg', 'jpeg', 'gif'])(
    'accepts Slack-supported .%s images',
    async (extension) => {
      const url = `https://raw.githubusercontent.com/acme/widgets/main/screenshot.${extension}`;
      await expect(
        extractEligiblePullRequestImages(
          `![Product screenshot](${url})`,
          async () =>
            extension === 'gif'
              ? 'image/gif'
              : extension === 'png'
                ? 'image/png'
                : 'image/jpeg',
        ),
      ).resolves.toEqual([
        expect.objectContaining({ url, altText: 'Product screenshot' }),
      ]);
    },
  );

  it('accepts a supported external HTTPS image by anonymous media type', async () => {
    await expect(
      extractEligiblePullRequestImages(
        '![Release preview](https://cdn.example.com/release-preview)',
        async () => 'image/jpeg',
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        url: 'https://cdn.example.com/release-preview',
        altText: 'Release preview',
      }),
    ]);
  });

  it('rejects badges, icons, unsafe URLs, and unsupported media', async () => {
    await expect(
      extractEligiblePullRequestImages(
        `
![Build badge](https://user-images.githubusercontent.com/1/build.png)
<img alt="App icon" src="https://github.com/user-attachments/assets/icon">
![Screenshot](http://user-images.githubusercontent.com/1/screenshot.png)
![UI screenshot](https://raw.githubusercontent.com/acme/widgets/main/screenshot.svg)
![Walkthrough screenshot](https://raw.githubusercontent.com/acme/widgets/main/walkthrough.mp4)
![Uploaded video screenshot](https://github.com/user-attachments/assets/walkthrough.mp4)
`,
        async (url) => (url.endsWith('.svg') ? 'image/svg+xml' : 'video/mp4'),
      ),
    ).resolves.toEqual([]);
  });

  it('rejects extensionless GitHub attachment videos by media type', async () => {
    await expect(
      extractEligiblePullRequestImages(
        '![Walkthrough screenshot](https://github.com/user-attachments/assets/opaque-video)',
        vi.fn().mockResolvedValue('video/mp4'),
      ),
    ).resolves.toEqual([]);
  });

  it('keeps a later candidate after an attachment has an unsupported media type', async () => {
    await expect(
      extractEligiblePullRequestImages(
        `![Product screenshot](https://github.com/user-attachments/assets/opaque-video)
![Updated settings](https://raw.githubusercontent.com/acme/widgets/main/settings.png)`,
        vi
          .fn()
          .mockResolvedValueOnce('video/mp4')
          .mockResolvedValueOnce('image/png'),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'image-1',
        url: 'https://raw.githubusercontent.com/acme/widgets/main/settings.png',
        altText: 'Updated settings',
      }),
    ]);
  });

  it('does not let rejected images consume the anonymous probe limit', async () => {
    const rejectedImages = Array.from(
      { length: 5 },
      (_, index) =>
        `![Build badge ${index + 1}](https://cdn.example.com/badge-${index + 1}.png)`,
    ).join('\n');
    const screenshotUrl = 'https://cdn.example.com/settings.png';
    const resolveMediaType = vi.fn().mockResolvedValue('image/png');

    await expect(
      extractEligiblePullRequestImages(
        `${rejectedImages}\n![Settings screenshot](${screenshotUrl})`,
        resolveMediaType,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        url: screenshotUrl,
        altText: 'Settings screenshot',
      }),
    ]);
    expect(resolveMediaType).toHaveBeenCalledOnce();
    expect(resolveMediaType).toHaveBeenCalledWith(screenshotUrl);
  });

  it('continues bounded probes after earlier images have unsupported media types', async () => {
    const unsupportedImages = Array.from(
      { length: 5 },
      (_, index) =>
        `![Preview ${index + 1}](https://cdn.example.com/video-${index + 1})`,
    ).join('\n');
    const screenshotUrl = 'https://cdn.example.com/settings-screenshot';
    const resolveMediaType = vi.fn(async (url: string) =>
      url === screenshotUrl ? 'image/png' : 'video/mp4',
    );

    await expect(
      extractEligiblePullRequestImages(
        `${unsupportedImages}\n![Settings screenshot](${screenshotUrl})`,
        resolveMediaType,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        url: screenshotUrl,
        altText: 'Settings screenshot',
      }),
    ]);
    expect(resolveMediaType).toHaveBeenCalledTimes(6);
  });

  it('does not probe beyond the remaining supported-image capacity', async () => {
    const imageUrls = Array.from(
      { length: 10 },
      (_, index) => `https://cdn.example.com/preview-${index + 1}`,
    );
    const resolveMediaType = vi.fn(async (url: string) =>
      imageUrls.indexOf(url) === 4 ? 'video/mp4' : 'image/png',
    );
    const candidates = imageUrls
      .map((url, index) => `![Preview ${index + 1}](${url})`)
      .join('\n');

    await expect(
      extractEligiblePullRequestImages(candidates, resolveMediaType),
    ).resolves.toHaveLength(5);
    expect(resolveMediaType).toHaveBeenCalledTimes(6);
    expect(resolveMediaType).not.toHaveBeenCalledWith(imageUrls[6]);
  });

  it('enriches GitHub merge pushes with bounded PR metadata and file stats', async () => {
    const payload = {
      ref: 'refs/heads/main',
      after: 'abcdef1234567890',
      installation: { id: 99 },
      repository: {
        id: 1,
        full_name: 'acme/widgets',
        html_url: 'https://github.com/acme/widgets',
        private: true,
      },
      commits: [{ id: 'abcdef1234567890', message: 'Merge pull request #7' }],
    };
    const event = normalizeGitHubPush(payload)!;
    const listPullRequestsAssociatedWithCommit = vi.fn().mockResolvedValue({
      data: [
        { number: 7, state: 'closed', base: { ref: 'main' } },
        { number: 8, state: 'open', base: { ref: 'main' } },
      ],
    });
    const get = vi.fn().mockResolvedValue({
      data: {
        number: 7,
        html_url: 'https://github.com/acme/widgets/pull/7',
        title: 'Ship widget export',
        body: `Adds the export and updates validation.

![Product screenshot](https://github.com/user-attachments/assets/product-preview)`,
        merged_at: '2026-08-29T12:00:00Z',
        merge_commit_sha: payload.after,
        base: { ref: 'main' },
        changed_files: 24,
        additions: 120,
        deletions: 15,
      },
    });
    const listFiles = vi.fn().mockResolvedValue({
      data: [
        {
          filename: 'src/widget.ts',
          status: 'modified',
          additions: 20,
          deletions: 4,
          patch: 'unbounded patch content must not be retained',
        },
      ],
    });
    const getInstallationOctokit = vi.fn().mockResolvedValue({
      rest: {
        repos: { listPullRequestsAssociatedWithCommit },
        pulls: { get, listFiles },
      },
    });
    const getAnonymousMediaType = vi.fn().mockResolvedValue('image/png');

    const enriched = await enrichGitHubMergeAnnouncerEvent(payload, event, {
      getInstallationOctokit: getInstallationOctokit as never,
      getAnonymousMediaType,
    });

    expect(getInstallationOctokit).toHaveBeenCalledWith({ installationId: 99 });
    expect(getAnonymousMediaType).toHaveBeenCalledWith(
      'https://github.com/user-attachments/assets/product-preview',
    );
    expect(listPullRequestsAssociatedWithCommit).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      commit_sha: payload.after,
      per_page: 10,
    });
    expect(get).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      pull_number: 7,
    });
    expect(listFiles).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      pull_number: 7,
      per_page: 20,
      page: 1,
    });
    expect(enriched.pullRequest).toEqual({
      number: 7,
      url: 'https://github.com/acme/widgets/pull/7',
      title: 'Ship widget export',
      body: `Adds the export and updates validation.

![Product screenshot](https://github.com/user-attachments/assets/product-preview)`,
      changedFileCount: 24,
      additions: 120,
      deletions: 15,
      imageCandidates: [
        expect.objectContaining({
          id: 'image-1',
          url: 'https://github.com/user-attachments/assets/product-preview',
          altText: 'Product screenshot',
        }),
      ],
      changedFiles: [
        {
          path: 'src/widget.ts',
          status: 'modified',
          additions: 20,
          deletions: 4,
        },
      ],
    });
    expect(JSON.stringify(enriched)).not.toContain('unbounded patch content');
  });

  it('enriches the associated PR while GitHub merge state is settling', async () => {
    const payload = {
      ref: 'refs/heads/develop',
      after: '9d606d9be06853438da729770fa04bb4e81d45e7',
      installation: { id: 99 },
      repository: {
        id: 1,
        full_name: 'RooCodeInc/Roomote',
        default_branch: 'develop',
      },
      commits: [
        {
          id: '9d606d9be06853438da729770fa04bb4e81d45e7',
          message:
            '[Fix] Memory titles overflow the Explore memories card (#1766)',
        },
      ],
    };
    const event = normalizeGitHubPush(payload)!;
    const listPullRequestsAssociatedWithCommit = vi.fn().mockResolvedValue({
      data: [{ number: 1766, state: 'open', base: { ref: 'develop' } }],
    });
    const get = vi.fn().mockResolvedValue({
      data: {
        number: 1766,
        html_url: 'https://github.com/RooCodeInc/Roomote/pull/1766',
        title: '[Fix] Memory titles overflow the Explore memories card',
        body: 'Keep memory titles inside the card.',
        merged_at: null,
        merge_commit_sha: payload.after,
        base: { ref: 'develop' },
        changed_files: 1,
        additions: 20,
        deletions: 20,
      },
    });
    const getInstallationOctokit = vi.fn().mockResolvedValue({
      rest: {
        repos: { listPullRequestsAssociatedWithCommit },
        pulls: {
          get,
          listFiles: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
    });

    const enriched = await enrichGitHubMergeAnnouncerEvent(payload, event, {
      getInstallationOctokit: getInstallationOctokit as never,
    });

    expect(listPullRequestsAssociatedWithCommit).toHaveBeenCalledOnce();
    expect(enriched.pullRequest).toMatchObject({
      number: 1766,
      url: 'https://github.com/RooCodeInc/Roomote/pull/1766',
    });
  });

  it.each([
    'fix: keep Session artifacts in execution details (#1896)',
    'Merge pull request #1896 from RooCodeInc/fix/session-artifacts',
  ])(
    'uses a verified PR number from the tip commit while GitHub associations settle: %s',
    async (message) => {
      const payload = {
        ref: 'refs/heads/develop',
        after: 'd17604dc8bbca8a20ebe1d68f722f72889c95c5e',
        installation: { id: 99 },
        repository: {
          id: 1,
          full_name: 'RooCodeInc/Roomote',
          default_branch: 'develop',
        },
        commits: [
          {
            id: 'd17604dc8bbca8a20ebe1d68f722f72889c95c5e',
            message,
          },
        ],
      };
      const event = normalizeGitHubPush(payload)!;
      const listPullRequestsAssociatedWithCommit = vi.fn().mockResolvedValue({
        data: [],
      });
      const get = vi.fn().mockResolvedValue({
        data: {
          number: 1896,
          html_url: 'https://github.com/RooCodeInc/Roomote/pull/1896',
          title: '[Improve] Keep Session artifacts in execution details',
          body: 'Open artifacts inside the execution-details panel without leaving the Session.',
          merge_commit_sha: payload.after,
          base: { ref: 'develop' },
          changed_files: 2,
          additions: 271,
          deletions: 100,
        },
      });
      const listFiles = vi.fn().mockResolvedValue({
        data: [
          {
            filename:
              'apps/web/src/app/(sandbox)/sessions/[sessionId]/SessionWorkspace.tsx',
            status: 'modified',
            additions: 92,
            deletions: 9,
          },
        ],
      });
      const getInstallationOctokit = vi.fn().mockResolvedValue({
        rest: {
          repos: { listPullRequestsAssociatedWithCommit },
          pulls: { get, listFiles },
        },
      });

      const enriched = await enrichGitHubMergeAnnouncerEvent(payload, event, {
        getInstallationOctokit: getInstallationOctokit as never,
      });

      expect(listPullRequestsAssociatedWithCommit).toHaveBeenCalledOnce();
      expect(get).toHaveBeenCalledWith({
        owner: 'RooCodeInc',
        repo: 'Roomote',
        pull_number: 1896,
      });
      expect(enriched.pullRequest).toEqual({
        number: 1896,
        url: 'https://github.com/RooCodeInc/Roomote/pull/1896',
        title: '[Improve] Keep Session artifacts in execution details',
        body: 'Open artifacts inside the execution-details panel without leaving the Session.',
        changedFileCount: 2,
        additions: 271,
        deletions: 100,
        changedFiles: [
          {
            path: 'apps/web/src/app/(sandbox)/sessions/[sessionId]/SessionWorkspace.tsx',
            status: 'modified',
            additions: 92,
            deletions: 9,
          },
        ],
      });
    },
  );

  it('rejects a PR number from the tip commit when its merge SHA does not match', async () => {
    const payload = {
      ref: 'refs/heads/main',
      after: 'abcdef1234567890',
      installation: { id: 99 },
      repository: { id: 1, full_name: 'acme/widgets' },
      commits: [{ id: 'abcdef1234567890', message: 'Ship widget (#7)' }],
    };
    const event = normalizeGitHubPush(payload)!;
    const getInstallationOctokit = vi.fn().mockResolvedValue({
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit: vi
            .fn()
            .mockResolvedValue({ data: [] }),
        },
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              merge_commit_sha: 'different-sha',
              base: { ref: 'main' },
            },
          }),
          listFiles: vi.fn(),
        },
      },
    });

    await expect(
      enrichGitHubMergeAnnouncerEvent(payload, event, {
        getInstallationOctokit: getInstallationOctokit as never,
      }),
    ).resolves.toBe(event);
  });

  it('does not infer a PR number when GitHub returns associated candidates', async () => {
    const payload = {
      ref: 'refs/heads/main',
      after: 'abcdef1234567890',
      installation: { id: 99 },
      repository: { id: 1, full_name: 'acme/widgets' },
      commits: [{ id: 'abcdef1234567890', message: 'Ship widget (#9)' }],
    };
    const event = normalizeGitHubPush(payload)!;
    const get = vi.fn().mockResolvedValue({
      data: {
        merge_commit_sha: 'different-sha',
        base: { ref: 'main' },
      },
    });
    const getInstallationOctokit = vi.fn().mockResolvedValue({
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit: vi.fn().mockResolvedValue({
            data: [{ number: 7, base: { ref: 'main' } }],
          }),
        },
        pulls: { get, listFiles: vi.fn() },
      },
    });

    await expect(
      enrichGitHubMergeAnnouncerEvent(payload, event, {
        getInstallationOctokit: getInstallationOctokit as never,
      }),
    ).resolves.toBe(event);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      pull_number: 7,
    });
  });

  it('does not infer a PR number from a commit other than the pushed tip', async () => {
    const payload = {
      ref: 'refs/heads/main',
      after: 'abcdef1234567890',
      installation: { id: 99 },
      repository: { id: 1, full_name: 'acme/widgets' },
      commits: [{ id: 'different-sha', message: 'Ship widget (#7)' }],
    };
    const event = normalizeGitHubPush(payload)!;
    const get = vi.fn();
    const getInstallationOctokit = vi.fn().mockResolvedValue({
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit: vi
            .fn()
            .mockResolvedValue({ data: [] }),
        },
        pulls: { get, listFiles: vi.fn() },
      },
    });

    await expect(
      enrichGitHubMergeAnnouncerEvent(payload, event, {
        getInstallationOctokit: getInstallationOctokit as never,
      }),
    ).resolves.toBe(event);
    expect(get).not.toHaveBeenCalled();
  });

  it('keeps commit-only context when GitHub PR enrichment fails', async () => {
    const payload = {
      ref: 'refs/heads/main',
      after: 'abcdef1234567890',
      installation: { id: 99 },
      repository: {
        id: 1,
        full_name: 'acme/widgets',
        html_url: 'https://github.com/acme/widgets',
      },
      commits: [{ id: 'abcdef1234567890', message: 'Ship widget' }],
    };
    const event = normalizeGitHubPush(payload)!;
    const getInstallationOctokit = vi
      .fn()
      .mockRejectedValue(new Error('GitHub unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      enrichGitHubMergeAnnouncerEvent(payload, event, {
        getInstallationOctokit: getInstallationOctokit as never,
      }),
    ).resolves.toBe(event);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to resolve merged pull request'),
    );

    warn.mockRestore();
  });

  it('keeps verified PR metadata and stats when changed files are unavailable', async () => {
    const payload = {
      ref: 'refs/heads/main',
      after: 'abcdef1234567890',
      installation: { id: 99 },
      repository: { id: 1, full_name: 'acme/widgets' },
      commits: [{ id: 'abcdef1234567890', message: 'Merge pull request #7' }],
    };
    const event = normalizeGitHubPush(payload)!;
    const listFiles = vi.fn().mockRejectedValue(new Error('files unavailable'));
    const getInstallationOctokit = vi.fn().mockResolvedValue({
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit: vi.fn().mockResolvedValue({
            data: [{ number: 7, state: 'closed', base: { ref: 'main' } }],
          }),
        },
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              number: 7,
              html_url: 'https://github.com/acme/widgets/pull/7',
              title: 'Ship widget export',
              body: 'Detailed rationale',
              merged_at: '2026-08-29T12:00:00Z',
              merge_commit_sha: payload.after,
              base: { ref: 'main' },
              changed_files: 24,
              additions: 120,
              deletions: 15,
            },
          }),
          listFiles,
        },
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const enriched = await enrichGitHubMergeAnnouncerEvent(payload, event, {
      getInstallationOctokit: getInstallationOctokit as never,
    });

    expect(enriched.pullRequest).toEqual({
      number: 7,
      url: 'https://github.com/acme/widgets/pull/7',
      title: 'Ship widget export',
      body: 'Detailed rationale',
      changedFileCount: 24,
      additions: 120,
      deletions: 15,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch changed files'),
    );
    warn.mockRestore();
  });

  it('keeps verified PR context when image extraction fails', async () => {
    const payload = {
      ref: 'refs/heads/main',
      after: 'abcdef1234567890',
      installation: { id: 99 },
      repository: {
        id: 1,
        full_name: 'acme/widgets',
        private: true,
      },
      commits: [{ id: 'abcdef1234567890', message: 'Merge pull request #7' }],
    };
    const event = normalizeGitHubPush(payload)!;
    const extractEligibleImages = vi.fn(() => {
      throw new Error('image parser unavailable');
    });
    const getInstallationOctokit = vi.fn().mockResolvedValue({
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit: vi.fn().mockResolvedValue({
            data: [{ number: 7, base: { ref: 'main' } }],
          }),
        },
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              number: 7,
              html_url: 'https://github.com/acme/widgets/pull/7',
              title: 'Ship widget export',
              body: '![Screenshot](https://github.com/user-attachments/assets/demo)',
              merge_commit_sha: payload.after,
              base: { ref: 'main' },
              changed_files: 1,
              additions: 20,
              deletions: 4,
            },
          }),
          listFiles: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const enriched = await enrichGitHubMergeAnnouncerEvent(payload, event, {
      getInstallationOctokit: getInstallationOctokit as never,
      extractEligibleImages,
    });

    expect(extractEligibleImages).toHaveBeenCalledOnce();
    expect(enriched.pullRequest).toMatchObject({
      number: 7,
      title: 'Ship widget export',
    });
    expect(enriched.pullRequest).not.toHaveProperty('imageCandidates');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to extract pull request images'),
    );
    warn.mockRestore();
  });

  it('uses anonymously fetchable images from private PR bodies', async () => {
    const payload = {
      ref: 'refs/heads/main',
      after: 'abcdef1234567890',
      installation: { id: 99 },
      repository: {
        id: 1,
        full_name: 'acme/widgets',
        private: true,
      },
      commits: [{ id: 'abcdef1234567890', message: 'Merge pull request #7' }],
    };
    const event = normalizeGitHubPush(payload)!;
    const extractEligibleImages = vi.fn().mockResolvedValue([
      {
        id: 'image-1',
        url: 'https://github.com/user-attachments/assets/demo',
        altText: 'Screenshot',
        surroundingText: '',
      },
    ]);
    const getInstallationOctokit = vi.fn().mockResolvedValue({
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit: vi.fn().mockResolvedValue({
            data: [{ number: 7, base: { ref: 'main' } }],
          }),
        },
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              number: 7,
              html_url: 'https://github.com/acme/widgets/pull/7',
              title: 'Ship widget export',
              body: '![Screenshot](https://github.com/user-attachments/assets/demo)',
              merge_commit_sha: payload.after,
              base: { ref: 'main' },
              changed_files: 1,
              additions: 20,
              deletions: 4,
            },
          }),
          listFiles: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
    });

    const enriched = await enrichGitHubMergeAnnouncerEvent(payload, event, {
      getInstallationOctokit: getInstallationOctokit as never,
      extractEligibleImages,
    });

    expect(extractEligibleImages).toHaveBeenCalledOnce();
    expect(enriched.pullRequest).toMatchObject({
      imageCandidates: [
        {
          id: 'image-1',
          url: 'https://github.com/user-attachments/assets/demo',
        },
      ],
    });
  });

  it('rejects associated PRs whose merge SHA is not the pushed tip', async () => {
    const payload = {
      ref: 'refs/heads/main',
      after: 'abcdef1234567890',
      installation: { id: 99 },
      repository: { id: 1, full_name: 'acme/widgets' },
      commits: [{ id: 'abcdef1234567890', message: 'Ship widget' }],
    };
    const event = normalizeGitHubPush(payload)!;
    const listFiles = vi.fn();
    const getInstallationOctokit = vi.fn().mockResolvedValue({
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit: vi.fn().mockResolvedValue({
            data: [
              { number: 7, state: 'closed', base: { ref: 'main' } },
              { number: 8, state: 'closed', base: { ref: 'main' } },
            ],
          }),
        },
        pulls: {
          get: vi
            .fn()
            .mockResolvedValueOnce({
              data: {
                merge_commit_sha: 'different-sha',
                base: { ref: 'main' },
              },
            })
            .mockResolvedValueOnce({
              data: {
                merge_commit_sha: payload.after,
                base: { ref: 'release' },
              },
            }),
          listFiles,
        },
      },
    });

    await expect(
      enrichGitHubMergeAnnouncerEvent(payload, event, {
        getInstallationOctokit: getInstallationOctokit as never,
      }),
    ).resolves.toBe(event);
    expect(listFiles).not.toHaveBeenCalled();
  });

  it('does not query PR associations for non-default GitHub branches', async () => {
    const payload = {
      ref: 'refs/heads/feature/widget',
      after: 'abcdef1234567890',
      installation: { id: 99 },
      repository: {
        id: 1,
        full_name: 'acme/widgets',
        default_branch: 'main',
      },
      commits: [{ id: 'abcdef1234567890', message: 'Ship widget' }],
    };
    const event = normalizeGitHubPush(payload)!;
    const getInstallationOctokit = vi.fn();

    await expect(
      enrichGitHubMergeAnnouncerEvent(payload, event, {
        getInstallationOctokit: getInstallationOctokit as never,
      }),
    ).resolves.toBe(event);
    expect(getInstallationOctokit).not.toHaveBeenCalled();
  });

  it('normalizes GitLab pushes and branch deletion', () => {
    const payload = gitLabPushWebhookSchema.parse({
      object_kind: 'push',
      ref: 'refs/heads/main',
      after: '0000000000000000000000000000000000000000',
      user_username: 'gitlab-user',
      project: {
        id: 2,
        path_with_namespace: 'acme/widgets',
        web_url: 'https://gitlab.example.com/acme/widgets',
      },
      commits: [
        {
          id: 'def',
          message: 'Update widget',
          author: { name: 'Dana', email: 'dana@example.com' },
        },
      ],
    });

    expect(normalizeGitLabPush(payload)).toMatchObject({
      provider: 'gitlab',
      deleted: true,
      pusher: 'gitlab-user',
      repository: { externalId: '2', host: 'gitlab.example.com' },
      commits: [{ author: { email: 'dana@example.com' } }],
    });
  });

  it('normalizes Gitea pusher and author usernames', () => {
    const payload = giteaPushWebhookSchema.parse({
      ref: 'refs/heads/main',
      pusher: { username: 'gitea-user' },
      repository: {
        id: 3,
        full_name: 'acme/widgets',
        html_url: 'https://gitea.example.com/acme/widgets',
      },
      commits: [
        {
          id: 'ghi',
          message: 'Refine widget',
          author: { username: 'erin', name: 'Erin' },
        },
      ],
    });

    expect(normalizeGiteaPush(payload)).toMatchObject({
      provider: 'gitea',
      pusher: 'gitea-user',
      repository: { externalId: '3', host: 'gitea.example.com' },
      commits: [{ author: { username: 'erin' } }],
    });
  });

  it('normalizes Bitbucket branch changes and excludes tag changes', () => {
    const payload = bitbucketPushWebhookSchema.parse({
      actor: { nickname: 'bitbucket-user' },
      repository: {
        uuid: '{repo-4}',
        full_name: 'acme/widgets',
        links: { html: { href: 'https://bitbucket.org/acme/widgets' } },
      },
      push: {
        changes: [
          {
            new: { name: 'main', type: 'branch' },
            commits: [
              {
                hash: 'jkl',
                message: 'Polish widget',
                author: {
                  raw: 'Frank <frank@example.com>',
                  user: { nickname: 'frank' },
                },
              },
            ],
          },
          { new: { name: 'v1.0.0', type: 'tag' }, commits: [] },
        ],
      },
    });

    expect(normalizeBitbucketPush(payload)).toEqual([
      expect.objectContaining({
        provider: 'bitbucket',
        ref: 'refs/heads/main',
        pusher: 'bitbucket-user',
        repository: {
          externalId: '{repo-4}',
          fullName: 'acme/widgets',
          host: 'bitbucket.org',
          htmlUrl: 'https://bitbucket.org/acme/widgets',
        },
        commits: [
          expect.objectContaining({
            author: expect.objectContaining({ username: 'frank' }),
          }),
        ],
      }),
    ]);
  });

  it('normalizes Azure DevOps ref updates and pushed-by attribution', () => {
    const payload = adoPushWebhookSchema.parse({
      id: 'delivery-5',
      eventType: 'git.push',
      resourceContainers: {
        account: { baseUrl: 'https://dev.azure.com/acme/' },
      },
      resource: {
        repository: {
          id: 'repo-5',
          name: 'widgets',
          project: { id: 'project-1', name: 'platform' },
          webUrl: 'https://dev.azure.com/acme/platform/_git/widgets',
        },
        refUpdates: [{ name: 'refs/heads/main' }],
        pushedBy: { displayName: 'Grace Hopper' },
        commits: [
          {
            commitId: 'mno',
            comment: 'Document widget',
            author: { name: 'Heidi', email: 'heidi@example.com' },
          },
        ],
      },
    });

    expect(normalizeAdoPush(payload)).toEqual([
      expect.objectContaining({
        provider: 'ado',
        ref: 'refs/heads/main',
        pusher: 'Grace Hopper',
        repository: expect.objectContaining({
          externalId: 'repo-5',
          host: 'dev.azure.com',
        }),
        commits: [
          expect.objectContaining({
            author: expect.objectContaining({
              name: 'Heidi',
              email: 'heidi@example.com',
            }),
          }),
        ],
      }),
    ]);
  });
});
