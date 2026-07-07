import { extractDirectories } from '../searchFiles';

describe('extractDirectories', () => {
  it('should extract all ancestor directories from file paths', () => {
    const files = ['src/utils/helpers.ts', 'src/index.ts', 'README.md'];
    const dirs = extractDirectories(files);

    expect(dirs).toEqual(['src', 'src/utils']);
  });

  it('should return an empty array for root-level files only', () => {
    const files = ['package.json', 'README.md', '.gitignore'];
    const dirs = extractDirectories(files);

    expect(dirs).toEqual([]);
  });

  it('should deduplicate directories shared by multiple files', () => {
    const files = [
      'src/components/Button.tsx',
      'src/components/Input.tsx',
      'src/hooks/useAuth.ts',
    ];
    const dirs = extractDirectories(files);

    expect(dirs).toEqual(['src', 'src/components', 'src/hooks']);
  });

  it('should handle deeply nested paths', () => {
    const files = ['a/b/c/d/file.ts'];
    const dirs = extractDirectories(files);

    expect(dirs).toEqual(['a', 'a/b', 'a/b/c', 'a/b/c/d']);
  });

  it('should return sorted results', () => {
    const files = ['z/file.ts', 'a/file.ts', 'm/nested/file.ts'];
    const dirs = extractDirectories(files);

    expect(dirs).toEqual(['a', 'm', 'm/nested', 'z']);
  });

  it('should handle an empty input array', () => {
    const dirs = extractDirectories([]);

    expect(dirs).toEqual([]);
  });
});
