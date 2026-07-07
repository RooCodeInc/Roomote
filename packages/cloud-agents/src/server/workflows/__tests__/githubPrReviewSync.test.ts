// pnpm --filter @roomote/cloud-agents test src/server/workflows/__tests__/githubPrReviewSync.test.ts

import * as utils from '../utils';

describe('githubPrReviewSync', () => {
  describe('getMarkdownChecklist unit tests', () => {
    it('should extract checklist items and preserve checked state', () => {
      const markdown = `
<!-- roomote-review-summary sha=abc123 mode=initial agent=agent_123 -->
Outstanding review items:
- [ ] Add regression coverage
- [x] Preserve existing wording
`;

      const result = utils.getMarkdownChecklist(markdown);

      expect(result).toBe(
        '- [ ] Add regression coverage\n- [x] Preserve existing wording',
      );
    });

    it('should preserve dismissed history bullets alongside checklist items', () => {
      const markdown = `
<!-- roomote-review-summary sha=abc123 mode=sync agent=agent_123 -->
1 issue outstanding.
- [ ] Keep unresolved issue visible
- ~~Ignore optional skipped checks~~ — dismissed: checks already passed.
`;

      const result = utils.getMarkdownChecklist(markdown);

      expect(result).toBe(
        '- [ ] Keep unresolved issue visible\n- ~~Ignore optional skipped checks~~ — dismissed: checks already passed.',
      );
    });

    it('should ignore hidden status and checklist markers while extracting checklist history', () => {
      const markdown = `
<!-- roomote-review-summary sha=abc123 mode=sync agent=agent_123 -->
<!-- roomote-review-status:start -->
No actionable issues found.
<!-- roomote-review-status:end -->
<!-- roomote-review-checklist:start -->
- [x] Existing issue was fixed
- ~~Ignore optional skipped checks~~ — dismissed: checks already passed.
<!-- roomote-review-checklist:end -->
`;

      const result = utils.getMarkdownChecklist(markdown);

      expect(result).toBe(
        '- [x] Existing issue was fixed\n- ~~Ignore optional skipped checks~~ — dismissed: checks already passed.',
      );
    });

    it('should return undefined when no checklist items exist', () => {
      expect(
        utils.getMarkdownChecklist('No actionable issues found.'),
      ).toBeUndefined();
    });
  });

  describe('formatChangedFiles unit tests', () => {
    it('should format changed files without truncation when under limit', () => {
      const files = ['src/app.ts', 'src/index.ts', 'package.json'];
      const result = utils.formatChangedFiles(files, 10);

      expect(result).toBe('- `src/app.ts`\n- `src/index.ts`\n- `package.json`');
    });

    it('should truncate changed files when exceeding limit', () => {
      const files = [
        'src/file1.ts',
        'src/file2.ts',
        'src/file3.ts',
        'src/file4.ts',
        'src/file5.ts',
      ];
      const result = utils.formatChangedFiles(files, 3);

      expect(result).toContain('- `src/file1.ts`');
      expect(result).toContain('- `src/file2.ts`');
      expect(result).toContain('- `src/file3.ts`');
      expect(result).not.toContain('file4');
      expect(result).toContain('[... +2 more files]');
    });

    it('should handle single remaining file in truncation message', () => {
      const files = ['src/file1.ts', 'src/file2.ts', 'src/file3.ts'];
      const result = utils.formatChangedFiles(files, 2);

      expect(result).toContain('[... +1 more file]');
    });

    it('should handle empty file list', () => {
      const result = utils.formatChangedFiles([]);

      expect(result).toContain('Unable to determine changed files');
    });

    it('should not truncate when limit is undefined', () => {
      const files = Array.from({ length: 100 }, (_, i) => `file${i}.ts`);
      const result = utils.formatChangedFiles(files);

      expect(result).not.toContain('more file');
      expect(result.split('\n').length).toBe(100);
    });
  });

  describe('getDiff unit tests', () => {
    it('should format diff without truncation when under limits', () => {
      const diff = 'line1\nline2\nline3';
      const result = utils.getDiff({
        prNumber: 123,
        repo: 'owner/repo',
        diff,
        lineLimit: 10,
        charLimit: 100_000,
      });

      expect(result).toContain('line1');
      expect(result).toContain('line3');
      expect(result).toContain('gh pr diff 123 --repo owner/repo --patch');
      expect(result).not.toContain('truncated');
    });

    it('should truncate diff when exceeding line limit', () => {
      const diff = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
      const result = utils.getDiff({
        prNumber: 123,
        repo: 'owner/repo',
        diff,
        lineLimit: 20,
        charLimit: 100_000,
      });

      expect(result).toContain('line0');
      expect(result).toContain('line19');
      expect(result).not.toContain('line20');
      expect(result).toContain('[... +80 more lines truncated');
    });

    it('should truncate diff when exceeding character limit', () => {
      const diff = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
      const result = utils.getDiff({
        prNumber: 123,
        repo: 'owner/repo',
        diff,
        charLimit: 50,
      });

      expect(result).toContain('truncated due to character limit');
    });

    it('should handle undefined diff', () => {
      const result = utils.getDiff({
        prNumber: 123,
        repo: 'owner/repo',
        diff: undefined,
        charLimit: 100_000,
      });

      expect(result).toContain('Diff is too large to display');
    });

    it('should handle single line in truncation message', () => {
      const diff = 'line1\nline2';
      const result = utils.getDiff({
        prNumber: 123,
        repo: 'owner/repo',
        diff,
        lineLimit: 1,
        charLimit: 100_000,
      });

      expect(result).toContain('[... +1 more line truncated');
    });

    it('should count empty lines correctly in character limit', () => {
      const diff = 'line1\n\n\nline2';
      const result = utils.getDiff({
        prNumber: 123,
        repo: 'owner/repo',
        diff,
        charLimit: 100_000,
      });

      expect(result).toContain('line1');
      expect(result).toContain('line2');
      expect(result).not.toContain('truncated');
    });

    it('should handle diff with only empty lines', () => {
      const diff = '\n\n\n';
      const result = utils.getDiff({
        prNumber: 123,
        repo: 'owner/repo',
        diff,
        charLimit: 100_000,
      });

      expect(result).not.toContain('truncated');
    });

    it('should truncate at character limit even with empty lines', () => {
      const diff = 'abcdefghij\n\n\nklmnopqrst';
      const result = utils.getDiff({
        prNumber: 123,
        repo: 'owner/repo',
        diff,
        charLimit: 15,
      });

      expect(result).toContain('truncated due to character limit');
    });
  });

  describe('getDiffInRange unit tests', () => {
    it('should format diff without truncation when under limit', () => {
      const diff = 'line1\nline2\nline3\nline4\nline5';
      const result = utils.getDiffInRange({
        repo: 'owner/repo',
        diff,
        range: ['sha1', 'sha2'],
        lineLimit: 10,
        charLimit: 100_000,
      });

      expect(result).toContain('line1');
      expect(result).toContain('line5');
      expect(result).not.toContain('truncated');
    });

    it('should truncate diff when exceeding limit', () => {
      const diff = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
      const result = utils.getDiffInRange({
        repo: 'owner/repo',
        diff,
        range: ['sha1', 'sha2'],
        lineLimit: 20,
        charLimit: 100_000,
      });

      expect(result).toContain('line0');
      expect(result).toContain('line19');
      expect(result).not.toContain('line20');
      expect(result).toContain('[... +80 more lines truncated');
    });

    it('should handle single line in truncation message', () => {
      const diff = 'line1\nline2';
      const result = utils.getDiffInRange({
        repo: 'owner/repo',
        diff,
        range: ['sha1', 'sha2'],
        lineLimit: 1,
        charLimit: 100_000,
      });

      expect(result).toContain('[... +1 more line truncated');
    });

    it('should handle undefined diff', () => {
      const result = utils.getDiffInRange({
        repo: 'owner/repo',
        diff: undefined,
        range: ['sha1', 'sha2'],
        charLimit: 100_000,
      });

      expect(result).toContain('Diff is too large to display');
    });

    it('should not truncate when lineLimit is undefined', () => {
      const diff = Array.from({ length: 1000 }, (_, i) => `line${i}`).join(
        '\n',
      );
      const result = utils.getDiffInRange({
        repo: 'owner/repo',
        diff,
        range: ['sha1', 'sha2'],
        charLimit: 100_000,
      });

      expect(result).not.toContain('truncated');
      expect(result).toContain('line999');
    });

    it('should truncate diff when exceeding character limit', () => {
      const diff = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
      const result = utils.getDiffInRange({
        repo: 'owner/repo',
        diff,
        range: ['sha1', 'sha2'],
        charLimit: 50,
      });

      expect(result).toContain('truncated due to character limit');
    });

    it('should count empty lines correctly in character limit', () => {
      const diff = 'line1\n\n\nline2';
      const result = utils.getDiffInRange({
        repo: 'owner/repo',
        diff,
        range: ['sha1', 'sha2'],
        charLimit: 100_000,
      });

      expect(result).toContain('line1');
      expect(result).toContain('line2');
      expect(result).not.toContain('truncated');
    });

    it('should handle diff with only empty lines', () => {
      const diff = '\n\n\n';
      const result = utils.getDiffInRange({
        repo: 'owner/repo',
        diff,
        range: ['sha1', 'sha2'],
        charLimit: 100_000,
      });

      expect(result).not.toContain('truncated');
    });

    it('should truncate at character limit even with empty lines', () => {
      const diff = 'abcdefghij\n\n\nklmnopqrst';
      const result = utils.getDiffInRange({
        repo: 'owner/repo',
        diff,
        range: ['sha1', 'sha2'],
        charLimit: 15,
      });

      expect(result).toContain('truncated due to character limit');
    });

    it('should prefer character limit truncation over line limit when both are hit', () => {
      const diff = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
      const result = utils.getDiffInRange({
        repo: 'owner/repo',
        diff,
        range: ['sha1', 'sha2'],
        lineLimit: 50,
        charLimit: 20,
      });

      expect(result).toContain('truncated due to character limit');
      expect(result).not.toContain('more lines truncated');
    });
  });
});
