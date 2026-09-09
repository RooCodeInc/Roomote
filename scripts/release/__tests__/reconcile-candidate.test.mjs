import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  reconcileCandidate,
  reconciliationBody,
} from '../reconcile-candidate.mjs';

const repository = 'example/roomote';
const history = '## 1.0.0\n\nOriginal release.\n';
const published = `## 1.0.1\n\nProduction hotfix.\n\n${history}`;
const notes = '## 1.1.0\n\nFrozen release notes.\n\n';

function fixture(
  t,
  {
    clean = false,
    pending = false,
    resolved = {},
    identical = false,
    mainFiles = {},
    candidateFiles = {},
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'reconcile-candidate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'work');
  const remote = join(root, 'remote.git');
  mkdirSync(cwd);
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: repository,
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trimEnd();
  };
  const write = (path, text) => writeFileSync(join(cwd, path), text);
  const commit = (message) => {
    git('add', '.');
    git('commit', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '--bare', remote);
  git('init', '-b', 'main');
  git('remote', 'add', 'origin', remote);
  mkdirSync(join(cwd, '.changeset'));
  write('.changeset/README.md', '# Changesets\n');
  write('package.json', '{"version":"1.0.0"}\n');
  write('CHANGELOG.md', `# Changelog\n\n${history}`);
  write('conflict.txt', 'base\n');
  write('unchanged.txt', 'unchanged\n');
  const base = commit('base');
  if (!clean) {
    write('package.json', '{"version":"1.0.1"}\n');
    write('CHANGELOG.md', `# Changelog\n\n${published}`);
    write('conflict.txt', 'production fix\n');
  }
  write('main-only.txt', 'automatic production change\n');
  for (const [path, text] of Object.entries(mainFiles)) write(path, text);
  const main = commit('main hotfix');
  git('checkout', '-b', 'release/v1.1.0', base);
  write('package.json', '{"version":"1.1.0"}\n');
  write('CHANGELOG.md', `# Changelog\n\n${notes}${history}`);
  write('conflict.txt', 'candidate feature\n');
  if (identical) {
    write('conflict.txt', clean ? 'base\n' : 'production fix\n');
    write('main-only.txt', 'automatic production change\n');
    write(
      'CHANGELOG.md',
      `# Changelog\n\n${notes}${clean ? history : published}`,
    );
  }
  for (const [path, text] of Object.entries(candidateFiles)) write(path, text);
  if (pending)
    write('.changeset/pending.md', '---\nroomote: patch\n---\nPending\n');
  const candidate = commit('frozen candidate');
  git('checkout', '-b', 'reconcile/v1.1.0');
  const merge = spawnSync('git', ['merge', '--no-commit', '--no-ff', main], {
    cwd,
    env,
    encoding: 'utf8',
  });
  assert.equal(merge.status, clean ? 0 : 1, merge.stderr);
  write('package.json', '{"version":"1.1.0"}\n');
  write(
    'CHANGELOG.md',
    `# Changelog\n\n${notes}${clean ? history : published}`,
  );
  write(
    'conflict.txt',
    identical
      ? clean
        ? 'base\n'
        : 'production fix\n'
      : clean
        ? 'candidate feature\n'
        : 'candidate feature with production fix\n',
  );
  for (const [path, text] of Object.entries(resolved)) write(path, text);
  const resolution = commit('reviewed resolution');
  git('push', 'origin', 'main', 'release/v1.1.0', 'reconcile/v1.1.0');
  // Tooling stays on trusted checkout; reconciliation must never checkout a pinned tree.
  git('checkout', '-b', 'develop', base);
  const pr = (number, branch, baseBranch, head, baseSha) => ({
    number,
    state: 'open',
    merged_at: null,
    body: 'Existing promotion notes.\n',
    user: { login: 'author' },
    html_url: `https://github.com/${repository}/pull/${number}`,
    head: { ref: branch, sha: head, repo: { full_name: repository } },
    base: { ref: baseBranch, sha: baseSha, repo: { full_name: repository } },
  });
  const state = {
    promote: pr(10, 'release/v1.1.0', 'main', candidate, main),
    review: pr(20, 'reconcile/v1.1.0', 'release/v1.1.0', resolution, candidate),
    reviews: [
      [
        {
          state: 'APPROVED',
          commit_id: resolution,
          user: { login: 'reviewer', type: 'User' },
          author_association: 'MEMBER',
        },
      ],
    ],
    threadPages: [
      { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    ],
    calls: [],
    bodies: [],
    before: () => {},
    failMetadata: false,
  };
  const run = (bin, args, options) => {
    state.calls.push([bin, ...args]);
    state.before(bin, args);
    if (bin === 'git') return spawnSync(bin, args, options);
    assert.equal(bin, 'gh');
    assert.equal(args[0], 'api');
    const endpoint = args[1];
    let value;
    if (args.includes('PATCH')) {
      if (state.failMetadata)
        return { status: 1, stdout: '', stderr: 'simulated metadata denial' };
      state.bodies.push(JSON.parse(options.input).body);
      value = {};
    } else if (endpoint === 'graphql') {
      const cursorArg = args.find((arg) => arg.startsWith('cursor='));
      const page = cursorArg ? Number(cursorArg.slice(7)) : 0;
      value = state.graphqlError ?? {
        data: {
          repository: {
            pullRequest: { reviewThreads: state.threadPages[page] },
          },
        },
      };
    } else if (endpoint.includes('/reviews?')) {
      assert.ok(args.includes('--paginate') && args.includes('--slurp'));
      value = state.reviews;
    } else if (endpoint.includes('/pulls?')) {
      assert.ok(args.includes('--paginate') && args.includes('--slurp'));
      value = [
        [endpoint.includes('base=main&') ? state.promote : state.review].filter(
          Boolean,
        ),
      ];
    } else if (endpoint.endsWith('/pulls/10')) {
      value = state.promote && {
        ...state.promote,
        head: {
          ...state.promote.head,
          sha:
            state.promoteHead ??
            git('--git-dir', remote, 'rev-parse', 'refs/heads/release/v1.1.0'),
        },
      };
    } else if (endpoint.endsWith('/pulls/20')) value = state.review;
    else assert.fail(`Unexpected gh API: ${endpoint}`);
    return { status: 0, stdout: JSON.stringify(value), stderr: '' };
  };
  const input = {
    version: '1.1.0',
    expected_candidate_sha: candidate,
    expected_main_sha: main,
    resolution_sha: resolution,
  };
  return {
    ...input,
    root,
    cwd,
    remote,
    env,
    git,
    write,
    commit,
    state,
    input,
    run,
    execute: () =>
      reconcileCandidate(input, {
        cwd,
        env,
        run,
        delay: () => {
          state.waits = (state.waits ?? 0) + 1;
        },
      }),
    remoteHead: () =>
      git('--git-dir', remote, 'rev-parse', 'refs/heads/release/v1.1.0'),
  };
}

function automaticFixture(t, options = {}) {
  const f = fixture(t, { identical: true, ...options });
  delete f.input.resolution_sha;
  f.git(
    '--git-dir',
    f.remote,
    'update-ref',
    '-d',
    'refs/heads/reconcile/v1.1.0',
  );
  f.state.review = null;
  f.state.reviews = [[]];
  return f;
}

for (const clean of [false, true]) {
  test(`automatic ${clean ? 'clean' : 'metadata conflict'} mode preserves full tree without review branch or PR`, (t) => {
    const f = automaticFixture(t, { clean });
    if (clean) f.input.resolution_sha = '';
    const result = f.execute();
    assert.equal(result.mode, 'verified-file-identical');
    assert.equal(result.reviewUrl, undefined);
    assert.equal(
      f.git('rev-parse', `${result.head}^{tree}`),
      f.git('rev-parse', `${f.expected_candidate_sha}^{tree}`),
    );
    assert.equal(
      f.git('show', '-s', '--format=%P', result.head),
      `${f.expected_candidate_sha} ${f.expected_main_sha}`,
    );
    assert.match(f.state.bodies[0], /verified file-identical/);
    assert.match(f.state.bodies[0], /fresh CI, reviews, and approval/);
    assert.match(
      f.git('show', '-s', '--format=%B', result.head),
      /Verified file-identical/,
    );
    assert.ok(
      !f.state.calls.some((call) =>
        call.some((arg) =>
          /reconcile\/v|reconcile%2F|reviews\?|graphql/.test(arg),
        ),
      ),
    );
  });
}

for (const [label, options] of [
  [
    'clean main-only change',
    { mainFiles: { 'extra.txt': 'production only\n' } },
  ],
  [
    'code conflict',
    { candidateFiles: { 'conflict.txt': 'candidate feature\n' } },
  ],
  [
    'dependency conflict',
    {
      mainFiles: {
        'package.json': '{"version":"1.0.1","dependencies":{"pkg":"2"}}\n',
      },
    },
  ],
  [
    'dropped published history',
    { candidateFiles: { 'CHANGELOG.md': `# Changelog\n\n${notes}${history}` } },
  ],
  [
    'different header',
    {
      candidateFiles: { 'CHANGELOG.md': `# Different\n\n${notes}${published}` },
    },
  ],
  [
    'intervening unpublished section',
    {
      candidateFiles: {
        'CHANGELOG.md': `# Changelog\n\n${notes}## 1.0.2\n\nUnpublished\n\n${published}`,
      },
    },
  ],
  [
    'candidate section not first',
    {
      candidateFiles: {
        'CHANGELOG.md': `# Changelog\n\n## 2.0.0\n\nUnpublished\n\n${notes}${published}`,
      },
    },
  ],
]) {
  test(`automatic mode requires review for ${label}`, (t) => {
    rejectsWithoutPush(
      automaticFixture(t, options),
      /Reviewed resolution required/,
    );
  });
}

test('automatic mode rejects clean-but-different merge', (t) => {
  rejectsWithoutPush(
    automaticFixture(t, {
      clean: true,
      mainFiles: { 'extra.txt': 'main only\n' },
    }),
    /Reviewed resolution required/,
  );
});

test('identical supplied resolution still requires exact-head review', (t) => {
  const f = fixture(t, { identical: true });
  f.state.reviews = [[]];
  rejectsWithoutPush(f, /Independent approval/);
});

for (const drift of ['main', 'release/v1.1.0', 'tag', 'closed']) {
  for (const late of [false, true]) {
    test(`automatic mode rejects ${late ? 'late' : 'initial'} ${drift}`, (t) => {
      const f = automaticFixture(t);
      const move = () => {
        if (drift === 'closed') f.state.promote.state = 'closed';
        else
          f.git(
            '--git-dir',
            f.remote,
            'update-ref',
            drift === 'tag' ? 'refs/tags/v1.1.0' : `refs/heads/${drift}`,
            drift === 'main' ? f.expected_candidate_sha : f.expected_main_sha,
          );
      };
      if (late) {
        let reads = 0;
        f.state.before = (bin, args) => {
          if (bin === 'gh' && args[1]?.endsWith('/pulls/10') && ++reads === 2)
            move();
        };
      } else move();
      rejectsWithoutPush(f, /pin drift|Shipped tag|mismatched PR/);
    });
  }
}

for (const variant of [
  'catches up',
  'permanent',
  'new head',
  'closed',
  'fork',
  'base',
  'pin drift',
]) {
  test(`post-push metadata ${variant} is bounded and never repeats push`, (t) => {
    const f = automaticFixture(t);
    let pushed = false;
    let reads = 0;
    f.state.before = (bin, args) => {
      if (bin === 'git' && args.includes('push')) pushed = true;
      if (
        pushed &&
        bin === 'gh' &&
        args[1]?.endsWith('/pulls/10') &&
        !args.includes('PATCH')
      ) {
        reads++;
        f.state.promoteHead =
          variant === 'catches up' && reads === 3
            ? undefined
            : f.expected_candidate_sha;
        if (variant === 'new head') f.state.promoteHead = f.expected_main_sha;
        if (variant === 'closed') f.state.promote.state = 'closed';
        if (variant === 'fork')
          f.state.promote.head.repo.full_name = 'other/repo';
        if (variant === 'base') f.state.promote.base.ref = 'develop';
        if (variant === 'pin drift')
          f.git(
            '--git-dir',
            f.remote,
            'update-ref',
            'refs/heads/main',
            f.expected_candidate_sha,
          );
      }
    };
    if (variant === 'catches up') {
      assert.ok(f.execute().head);
      assert.equal(reads, 3);
      assert.equal(f.state.waits, 2);
      assert.equal(f.state.bodies.length, 1);
    } else {
      assert.throws(
        f.execute,
        /Candidate pushed successfully.*metadata update failed/,
      );
      assert.equal(reads, variant === 'permanent' ? 5 : 1);
      assert.equal(f.state.bodies.length, 0);
      assert.equal(
        f.state.waits ?? 0,
        variant === 'permanent' ? 4 : variant === 'pin drift' ? 1 : 0,
      );
    }
    assert.equal(
      f.state.calls.filter(
        ([bin, ...args]) => bin === 'git' && args.includes('push'),
      ).length,
      1,
    );
  });
}

test('automatic mode rejects multiple real merge bases', (t) => {
  const f = automaticFixture(t);
  const candidate = f.expected_candidate_sha;
  const main = f.expected_main_sha;
  const left = f.git(
    'commit-tree',
    `${candidate}^{tree}`,
    '-p',
    candidate,
    '-p',
    main,
    '-m',
    'left merge',
  );
  const right = f.git(
    'commit-tree',
    `${main}^{tree}`,
    '-p',
    main,
    '-p',
    candidate,
    '-m',
    'right merge',
  );
  for (const [branch, sha] of [
    ['main', right],
    ['release/v1.1.0', left],
  ])
    f.git(
      '--git-dir',
      f.remote,
      'fetch',
      f.cwd,
      `+${sha}:refs/heads/${branch}`,
    );
  f.input.expected_candidate_sha = left;
  f.input.expected_main_sha = right;
  f.state.promote.base.sha = right;
  rejectsWithoutPush(
    f,
    /Reviewed resolution required: automatic mode requires exactly one merge base/,
  );
});

test('automatic mode rejects pending changesets', (t) => {
  rejectsWithoutPush(
    automaticFixture(t, { pending: true }),
    /Pending changesets/,
  );
});

test('automatic fast-forward push rejects concurrent candidate movement', (t) => {
  const f = automaticFixture(t);
  f.write('concurrent.txt', 'unrelated\n');
  const other = f.commit('concurrent');
  f.git('--git-dir', f.remote, 'fetch', f.cwd, other);
  f.state.before = (bin, args) => {
    if (bin === 'git' && args.includes('push'))
      f.git(
        '--git-dir',
        f.remote,
        'update-ref',
        'refs/heads/release/v1.1.0',
        other,
      );
  };
  assert.throws(f.execute, /failed/);
  assert.equal(f.remoteHead(), other);
  assert.equal(f.state.bodies.length, 0);
});

function rejectsWithoutPush(f, pattern) {
  assert.throws(f.execute, pattern);
  assert.ok(
    !f.state.calls.some(
      ([bin, ...args]) => bin === 'git' && args.includes('push'),
    ),
  );
  assert.equal(f.state.bodies.length, 0);
}

for (const clean of [false, true]) {
  test(`reconciles a real ${clean ? 'clean' : 'conflicted'} merge without executing pinned code`, (t) => {
    const f = fixture(t, { clean });
    const checkout = f.git('rev-parse', 'HEAD');
    const config = f.git('config', '--local', '--list');
    const result = f.execute();
    assert.equal(f.remoteHead(), result.head);
    assert.equal(
      f.git('show', '-s', '--format=%P', result.head),
      `${f.expected_candidate_sha} ${f.expected_main_sha}`,
    );
    assert.equal(
      f.git('rev-parse', `${result.head}^{tree}`),
      f.git('rev-parse', `${f.resolution_sha}^{tree}`),
    );
    assert.equal(
      f.git('show', `${result.head}:main-only.txt`),
      'automatic production change',
    );
    assert.equal(
      f.git('show', '-s', '--format=%an', result.head),
      'github-actions[bot]',
    );
    assert.equal(f.git('rev-parse', 'HEAD'), checkout);
    assert.equal(f.git('config', '--local', '--list'), config);
    assert.equal(f.state.bodies.length, 1);
    assert.ok(f.state.bodies[0].startsWith('Existing promotion notes.\n'));
    for (const pin of [
      f.expected_candidate_sha,
      f.expected_main_sha,
      f.resolution_sha,
      result.head,
    ])
      assert.ok(f.state.bodies[0].includes(pin));
    assert.ok(
      !f.state.calls.some(
        (call) =>
          call.includes('checkout') ||
          call.includes('--force') ||
          call.includes('--force-with-lease'),
      ),
    );
    assert.equal(
      f.state.calls.filter((call) =>
        call.some((arg) => arg.includes('/reviews?')),
      ).length,
      2,
    );
  });
}

for (const [label, resolved, pattern] of [
  [
    'unrelated file',
    { 'unchanged.txt': 'new develop code\n' },
    /outside conflicted paths/,
  ],
  [
    'dropped automatic main change',
    { 'main-only.txt': 'lost hotfix\n' },
    /outside conflicted paths/,
  ],
  [
    'wrong root version',
    { 'package.json': '{"version":"1.0.1"}\n' },
    /Incorrect root version/,
  ],
  [
    'edited candidate notes',
    {
      'CHANGELOG.md': `# Changelog\n\n## 1.1.0\n\nChanged notes\n\n${published}`,
    },
    /Candidate release section/,
  ],
  [
    'dropped published hotfix',
    { 'CHANGELOG.md': `# Changelog\n\n${notes}${history}` },
    /Published main changelog history/,
  ],
  [
    'edited older published history',
    {
      'CHANGELOG.md': `# Changelog\n\n${notes}${published.replace('Original release.', 'Rewritten history.')}`,
    },
    /Published main changelog history/,
  ],
  [
    'conflict markers',
    { 'conflict.txt': '<<<<<<< ours\nfeature\n=======\nfix\n>>>>>>> theirs\n' },
    /git .*failed/,
  ],
]) {
  test(`rejects ${label}`, (t) =>
    rejectsWithoutPush(fixture(t, { resolved }), pattern));
}

test('rejects pending changesets already present in the automatic tree', (t) => {
  rejectsWithoutPush(fixture(t, { pending: true }), /Pending changesets/);
});

test('rejects a reviewed descendant containing newer develop ancestry', (t) => {
  const f = fixture(t);
  f.git('checkout', 'reconcile/v1.1.0');
  f.write('new-develop.txt', 'not in candidate or main\n');
  const sha = f.commit('later develop work');
  f.git(
    '--git-dir',
    f.remote,
    'fetch',
    f.cwd,
    `${sha}:refs/heads/reconcile/v1.1.0`,
  );
  f.input.resolution_sha = sha;
  f.state.review.head.sha = sha;
  f.state.reviews[0][0].commit_id = sha;
  rejectsWithoutPush(f, /Resolution parents/);
});

for (const branch of ['main', 'release/v1.1.0', 'reconcile/v1.1.0']) {
  for (const late of [false, true]) {
    test(`rejects ${late ? 'last-moment' : 'initial'} ${branch} drift`, (t) => {
      const f = fixture(t);
      const drift = () =>
        f.git(
          '--git-dir',
          f.remote,
          'update-ref',
          `refs/heads/${branch}`,
          f.expected_main_sha ===
            f.git('--git-dir', f.remote, 'rev-parse', `refs/heads/${branch}`)
            ? f.expected_candidate_sha
            : f.expected_main_sha,
        );
      if (late) {
        let fetches = 0;
        f.state.before = (bin, args) => {
          if (bin === 'git' && args.includes('fetch') && ++fetches === 2)
            drift();
        };
      } else drift();
      rejectsWithoutPush(f, /Remote pin drift/);
    });
  }
}

for (const late of [false, true]) {
  test(`rejects ${late ? 'late' : 'existing'} shipped tag outside main ancestry`, (t) => {
    const f = fixture(t);
    const tag = () =>
      f.git(
        '--git-dir',
        f.remote,
        'update-ref',
        'refs/tags/v1.1.0',
        f.resolution_sha,
      );
    if (late) {
      let fetches = 0;
      f.state.before = (bin, args) => {
        if (bin === 'git' && args.includes('fetch') && ++fetches === 2) tag();
      };
    } else tag();
    rejectsWithoutPush(f, /Shipped tag/);
  });
}

test('rejects candidate already in main even without a tag', (t) => {
  const f = fixture(t);
  f.git(
    '--git-dir',
    f.remote,
    'update-ref',
    'refs/heads/main',
    f.resolution_sha,
  );
  f.input.expected_main_sha = f.resolution_sha;
  rejectsWithoutPush(f, /Candidate already in main/);
});

for (const target of ['promote', 'review']) {
  for (const variant of ['missing', 'closed', 'wrong base', 'fork']) {
    test(`rejects ${variant} ${target} PR`, (t) => {
      const f = fixture(t);
      if (variant === 'missing') f.state[target] = null;
      if (variant === 'closed') f.state[target].state = 'closed';
      if (variant === 'wrong base') f.state[target].base.ref = 'develop';
      if (variant === 'fork')
        f.state[target].head.repo.full_name = 'outsider/roomote';
      rejectsWithoutPush(f, /open PR|mismatched PR/);
    });
  }
}

for (const variant of [
  'stale',
  'self',
  'bot',
  'outsider',
  'dismissed',
  'changes requested',
  'comment after changes',
  'no approvals',
]) {
  test(`rejects ${variant} approval`, (t) => {
    const f = fixture(t);
    const approval = f.state.reviews[0][0];
    if (variant === 'stale') approval.commit_id = f.expected_candidate_sha;
    if (variant === 'self') approval.user.login = 'AUTHOR';
    if (variant === 'bot') approval.user.type = 'Bot';
    if (variant === 'outsider') approval.author_association = 'NONE';
    if (variant === 'dismissed') approval.state = 'DISMISSED';
    if (variant === 'no approvals') f.state.reviews = [[]];
    if (variant.includes('changes')) {
      f.state.reviews.push([
        {
          ...approval,
          user: { login: 'another', type: 'User' },
          state: 'CHANGES_REQUESTED',
          commit_id: f.expected_candidate_sha,
        },
      ]);
      if (variant === 'comment after changes')
        f.state.reviews.push([
          { ...f.state.reviews[1][0], state: 'COMMENTED' },
        ]);
    }
    rejectsWithoutPush(f, /approval|CHANGES_REQUESTED/);
  });
}

test('accepts approval superseding changes requested across review pages', (t) => {
  const f = fixture(t);
  const approval = f.state.reviews[0][0];
  f.state.reviews = [
    [{ ...approval, state: 'CHANGES_REQUESTED' }],
    [approval, { ...approval, state: 'COMMENTED' }],
  ];
  f.state.threadPages = [
    {
      nodes: [{ isResolved: true }],
      pageInfo: { hasNextPage: true, endCursor: '1' },
    },
    {
      nodes: [{ isResolved: true }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  ];
  assert.ok(f.execute().head);
});

for (const variant of [
  'unresolved later page',
  'missing cursor',
  'graphql error',
  'missing response',
]) {
  test(`fails closed on ${variant}`, (t) => {
    const f = fixture(t);
    if (variant === 'graphql error')
      f.state.graphqlError = {
        errors: [{ message: 'permission denied' }],
        data: null,
      };
    else if (variant === 'missing response') f.state.threadPages = [];
    else
      f.state.threadPages = [
        {
          nodes: [{ isResolved: true }],
          pageInfo: {
            hasNextPage: true,
            endCursor: variant === 'missing cursor' ? null : '1',
          },
        },
        {
          nodes: [{ isResolved: false }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      ];
    rejectsWithoutPush(f, /review thread/);
  });
}

test('rechecks approval immediately before pushing', (t) => {
  const f = fixture(t);
  let requests = 0;
  f.state.before = (bin, args) => {
    if (bin === 'gh' && args[1]?.includes('/reviews?') && ++requests === 2)
      f.state.reviews[0][0].state = 'CHANGES_REQUESTED';
  };
  rejectsWithoutPush(f, /CHANGES_REQUESTED/);
});

test('rechecks Promote PR before pushing', (t) => {
  const f = fixture(t);
  let requests = 0;
  f.state.before = (bin, args) => {
    if (bin === 'gh' && args[1]?.endsWith('/pulls/10') && ++requests === 2)
      f.state.promote.state = 'closed';
  };
  rejectsWithoutPush(f, /mismatched PR/);
});

test('reports a post-push metadata failure without pretending to roll back', (t) => {
  const f = fixture(t);
  f.state.failMetadata = true;
  assert.throws(
    f.execute,
    /Candidate pushed successfully to [a-f0-9]{40}, but Promote PR metadata update failed: .*simulated metadata denial/,
  );
  assert.notEqual(f.remoteHead(), f.expected_candidate_sha);
  assert.equal(f.state.bodies.length, 0);
});

test('ordinary fast-forward push rejects concurrent divergent candidate movement', (t) => {
  const f = fixture(t);
  f.write('concurrent.txt', 'unrelated branch\n');
  const other = f.commit('concurrent work');
  f.git('--git-dir', f.remote, 'fetch', f.cwd, other);
  f.state.before = (bin, args) => {
    if (bin === 'git' && args.includes('push'))
      f.git(
        '--git-dir',
        f.remote,
        'update-ref',
        'refs/heads/release/v1.1.0',
        other,
      );
  };
  assert.throws(f.execute, /failed/);
  assert.equal(f.remoteHead(), other);
  assert.equal(f.state.bodies.length, 0);
});

test('metadata section is bounded, idempotent and preserves surrounding text', () => {
  const metadata = {
    candidate: 'a',
    main: 'b',
    resolution: 'c',
    reviewUrl: 'https://example.com/20',
    head: 'd',
  };
  const once = reconciliationBody('Original notes', metadata);
  assert.equal(reconciliationBody(once, metadata), once);
  const updated = reconciliationBody(`${once}\nAfterword`, {
    ...metadata,
    head: 'new',
  });
  assert.ok(updated.startsWith('Original notes\n\n'));
  assert.ok(updated.endsWith('\nAfterword'));
  assert.equal(updated.split('### Candidate reconciliation').length, 2);
  assert.throws(
    () => reconciliationBody('<!-- release-reconciliation:start -->', metadata),
    /Malformed/,
  );
  assert.throws(
    () => reconciliationBody('x'.repeat(60000), metadata),
    /size limit/,
  );
});

test('invalid dispatch arguments are rejected before subprocesses', () => {
  for (const input of [
    { version: '1.1.0; echo bad' },
    { version: 'v1.1.0' },
    { version: '1.1.0', expected_candidate_sha: 'HEAD' },
  ])
    assert.throws(
      () =>
        reconcileCandidate(input, {
          run: () => assert.fail('must not execute'),
        }),
      /version|SHA/,
    );
});
