import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('githubPrReview prompt source', () => {
  it('routes GitHub PR review prompts through standardTask without GitHub fix links', () => {
    const thisFilePath = fileURLToPath(import.meta.url);
    const thisDirPath = path.dirname(thisFilePath);
    const workflowPath = path.resolve(thisDirPath, '../githubPrReview.ts');
    const workflowContent = fs.readFileSync(workflowPath, 'utf8');

    expect(workflowContent).toContain(
      'const prompt = buildStructuredTaskRequest({',
    );
    expect(workflowContent).toContain("requestFormat: 'structured'");
    expect(workflowContent).toContain(
      'findReusableReviewSummaryComment(issueComments)',
    );
    expect(workflowContent).toContain(
      'linked_implementation_task_handoff_enabled: relayReviewResultsToTask',
    );
    expect(workflowContent).toContain(
      'linked_implementation_task_id: linkedTaskId',
    );
    expect(workflowContent).toContain('task_link_follow: followLink');
    expect(workflowContent).toContain(
      'task_link_see: `[See task](${cloudJobUrl})`',
    );
    expect(workflowContent).not.toContain('task_link_fix_all:');
    expect(workflowContent).not.toContain('fix_issue_base_url:');
  });
});
