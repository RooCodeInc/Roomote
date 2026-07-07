import {
  postFailureComment,
  postResolutionComment,
  postTaskStartFailureComment,
} from '../post-comment';
import type { OctokitClient } from '../types';

function makeOctokit(): OctokitClient {
  return {
    rest: {
      issues: {
        createComment: vi.fn().mockResolvedValue({ data: { id: 123 } }),
      },
    },
  } as unknown as OctokitClient;
}

describe('post-comment formatting', () => {
  it('formats the detailed success comment with files and decisions', async () => {
    const octokit = makeOctokit();

    await postResolutionComment(octokit, 'owner', 'repo', 42, {
      resolvedFiles: ['path/to/file.ts'],
      controversialDecisions: ['Kept the incoming branch version.'],
      warnings: ['Unused in comment output.'],
    });

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 42,
      body: [
        'Resolved merge conflicts in:',
        '- `path/to/file.ts`',
        '',
        "Decisions I'm not 100% sure:",
        '- Kept the incoming branch version.',
        '',
        'Warnings:',
        '- Unused in comment output.',
      ].join('\n'),
    });
  });

  it('formats the failure comment without an emoji', async () => {
    const octokit = makeOctokit();

    await postFailureComment(octokit, 'owner', 'repo', 42, {
      reason: 'The automated resolution encountered an error.',
      isReviewBlock: true,
    });

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 42,
      body: [
        'I detected merge conflicts but could not automatically resolve them:',
        'The automated resolution encountered an error.',
      ].join('\n'),
    });
  });

  it('formats the task-start failure comment as a single sentence', async () => {
    const octokit = makeOctokit();

    await postTaskStartFailureComment(octokit, 'owner', 'repo', 42);

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 42,
      body: 'I detected merge conflicts but could not start a task to address them.',
    });
  });
});
