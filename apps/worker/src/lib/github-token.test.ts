import { isReadOnlySourceControlWrite } from './github-token';

describe('read-only source-control proxy', () => {
  it('blocks receive-pack but permits clone and fetch paths', () => {
    const credential = { readOnly: true };
    expect(
      isReadOnlySourceControlWrite(
        credential,
        'owner/repo.git/git-receive-pack',
        null,
      ),
    ).toBe(true);
    expect(
      isReadOnlySourceControlWrite(
        credential,
        'owner/repo.git/info/refs',
        'git-receive-pack',
      ),
    ).toBe(true);
    expect(
      isReadOnlySourceControlWrite(
        credential,
        'owner/repo.git/info/refs',
        'git-upload-pack',
      ),
    ).toBe(false);
    expect(
      isReadOnlySourceControlWrite(
        { readOnly: false },
        'owner/repo.git/git-receive-pack',
        null,
      ),
    ).toBe(false);
  });
});
