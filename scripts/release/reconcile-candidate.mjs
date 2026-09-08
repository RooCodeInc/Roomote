import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { extractChangelogSection } from './lib.mjs';

const shaPattern = /^[a-f0-9]{40}$/;
const startMarker = '<!-- release-reconciliation:start -->';
const endMarker = '<!-- release-reconciliation:end -->';

export function reconciliationBody(
  body,
  { candidate, main, resolution, reviewUrl, head },
) {
  if (typeof body !== 'string') throw new Error('Missing Promote PR body');
  const section = `${startMarker}\n### Candidate reconciliation\n\n- Frozen candidate: \`${candidate}\`\n- Pinned main: \`${main}\`\n- Reviewed resolution: \`${resolution}\` (${reviewUrl})\n- CI merge head: \`${head}\`\n\nThe candidate tree includes only the automatic merge and reviewed conflict resolutions.\n${endMarker}`;
  const start = body.indexOf(startMarker);
  const end = body.indexOf(endMarker);
  if (
    start < 0 !== end < 0 ||
    (start >= 0 &&
      (end < start ||
        body.indexOf(startMarker, start + 1) >= 0 ||
        body.indexOf(endMarker, end + 1) >= 0))
  )
    throw new Error('Malformed reconciliation metadata markers');
  const result =
    start < 0
      ? `${body}\n\n${section}`
      : `${body.slice(0, start)}${section}${body.slice(end + endMarker.length)}`;
  if (result.length > 60000)
    throw new Error('Promote PR body exceeds reconciliation size limit');
  return result;
}

// The injected runner is for deterministic tests; the CLI never accepts executable paths.
export function reconcileCandidate(
  input,
  { cwd = process.cwd(), env = process.env, run = spawnSync } = {},
) {
  const {
    version,
    expected_candidate_sha: candidate,
    expected_main_sha: main,
    resolution_sha: resolution,
  } = input;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) {
    throw new Error('version must be a stable version without v');
  }
  for (const [name, sha] of Object.entries({ candidate, main, resolution })) {
    if (!shaPattern.test(sha ?? ''))
      throw new Error(`${name} must be a full lowercase 40-character SHA`);
  }
  const repository = env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? ''))
    throw new Error('Missing or invalid GITHUB_REPOSITORY');
  const [owner, name] = repository.split('/');
  const releaseBranch = `release/v${version}`;
  const reviewBranch = `reconcile/v${version}`;
  const commandEnv = {
    ...env,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'github-actions[bot]',
    GIT_COMMITTER_NAME: 'github-actions[bot]',
    GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    GIT_COMMITTER_EMAIL:
      '41898282+github-actions[bot]@users.noreply.github.com',
  };
  function command(bin, args, { input: stdin, statuses = [0] } = {}) {
    const result = run(bin, args, {
      cwd,
      env: commandEnv,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      input: stdin,
    });
    if (result.error || !statuses.includes(result.status)) {
      throw new Error(
        `${bin} ${args[0]} failed: ${result.error?.message ?? result.stderr ?? result.status}`,
      );
    }
    return result;
  }
  const git = (...args) =>
    command('git', [
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ]).stdout.trimEnd();
  const api = (...args) => JSON.parse(command('gh', ['api', ...args]).stdout);
  function pages(endpoint) {
    const result = api(endpoint, '--paginate', '--slurp');
    if (
      !Array.isArray(result) ||
      !result.length ||
      result.some((page) => !Array.isArray(page))
    ) {
      throw new Error('Incomplete GitHub pagination response');
    }
    return result.flat();
  }
  function pins(expectedHead = candidate) {
    git(
      'fetch',
      '--no-recurse-submodules',
      '--tags',
      'origin',
      ...['main', releaseBranch, reviewBranch].map(
        (branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ),
    );
    for (const [branch, sha] of [
      ['main', main],
      [releaseBranch, expectedHead],
      [reviewBranch, resolution],
    ]) {
      if (git('rev-parse', `refs/remotes/origin/${branch}`) !== sha)
        throw new Error(`Remote pin drift: ${branch}`);
    }
    // A tag is a shipment guard even when it points outside main's ancestry.
    if (
      git('tag', '--list', `v${version}`) ||
      git('ls-remote', '--tags', 'origin', `refs/tags/v${version}`).length
    ) {
      throw new Error(`Shipped tag v${version} already exists`);
    }
    const ancestor = command(
      'git',
      ['merge-base', '--is-ancestor', candidate, main],
      { statuses: [0, 1] },
    );
    if (ancestor.status === 0) throw new Error('Candidate already in main');
  }
  function pullRequest(branch, base, headSha, baseSha, number) {
    if (number === undefined) {
      const matches = pages(
        `repos/${repository}/pulls?state=open&base=${encodeURIComponent(base)}&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`,
      );
      if (matches.length !== 1)
        throw new Error(`Expected exactly one open PR for ${branch}`);
      number = matches[0].number;
    }
    if (!Number.isSafeInteger(number) || number <= 0)
      throw new Error('Invalid PR number');
    const pr = api(`repos/${repository}/pulls/${number}`);
    if (
      pr.number !== number ||
      pr.state !== 'open' ||
      pr.merged_at !== null ||
      pr.head?.ref !== branch ||
      pr.base?.ref !== base ||
      pr.head?.sha !== headSha ||
      pr.base?.sha !== baseSha ||
      pr.head?.repo?.full_name !== repository ||
      pr.base?.repo?.full_name !== repository ||
      !pr.user?.login ||
      typeof pr.html_url !== 'string'
    ) {
      throw new Error(`Closed or mismatched PR for ${branch}`);
    }
    return pr;
  }
  function reviewed(pr) {
    const latest = new Map();
    for (const review of pages(
      `repos/${repository}/pulls/${pr.number}/reviews?per_page=100`,
    )) {
      if (
        !review.user?.login ||
        ![
          'APPROVED',
          'CHANGES_REQUESTED',
          'DISMISSED',
          'COMMENTED',
          'PENDING',
        ].includes(review.state)
      ) {
        throw new Error('Incomplete review data');
      }
      // REST returns reviews in chronological order. Comments do not clear a vote.
      if (!['COMMENTED', 'PENDING'].includes(review.state))
        latest.set(review.user.login.toLowerCase(), review);
    }
    if (
      [...latest.values()].some(
        (review) => review.state === 'CHANGES_REQUESTED',
      )
    ) {
      throw new Error('Outstanding CHANGES_REQUESTED review');
    }
    if (
      ![...latest.values()].some(
        (review) =>
          review.state === 'APPROVED' &&
          review.commit_id === resolution &&
          review.user.login.toLowerCase() !== pr.user.login.toLowerCase() &&
          review.user.type === 'User' &&
          ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(
            review.author_association,
          ),
      )
    ) {
      throw new Error('Independent approval at exact resolution SHA required');
    }
    let cursor;
    const seen = new Set();
    do {
      const result = api(
        'graphql',
        '-f',
        'query=query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}',
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-F',
        `number=${pr.number}`,
        ...(cursor ? ['-f', `cursor=${cursor}`] : []),
      );
      const threads = result.data?.repository?.pullRequest?.reviewThreads;
      if (
        result.errors?.length ||
        !Array.isArray(threads?.nodes) ||
        typeof threads.pageInfo?.hasNextPage !== 'boolean'
      ) {
        throw new Error('Incomplete review thread response');
      }
      if (threads.nodes.some((thread) => thread?.isResolved !== true))
        throw new Error('Unresolved review thread');
      if (!threads.pageInfo.hasNextPage) break;
      cursor = threads.pageInfo.endCursor;
      if (typeof cursor !== 'string' || !cursor || seen.has(cursor))
        throw new Error('Incomplete review thread pagination');
      seen.add(cursor);
    } while (cursor);
  }

  pins();
  const promote = pullRequest(releaseBranch, 'main', candidate, main);
  const review = pullRequest(
    reviewBranch,
    releaseBranch,
    resolution,
    candidate,
  );
  reviewed(review);
  // Exact parents exclude newer develop ancestry as well as ungrounded resolution diffs.
  if (git('show', '-s', '--format=%P', resolution) !== `${candidate} ${main}`) {
    throw new Error('Resolution parents must be exactly candidate then main');
  }
  const merge = command(
    'git',
    [
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      '-z',
      candidate,
      main,
    ],
    { statuses: [0, 1] },
  );
  const [automaticTree, ...paths] = merge.stdout.split('\0');
  if (
    !shaPattern.test(automaticTree) ||
    paths.at(-1) !== '' ||
    (merge.status === 1 && paths.length < 2)
  ) {
    throw new Error('Invalid merge-tree conflict report');
  }
  const conflicts = new Set(paths.filter(Boolean));
  const resolvedTree = git('rev-parse', `${resolution}^{tree}`);
  const changed = git(
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '--no-renames',
    '-r',
    '-z',
    automaticTree,
    resolvedTree,
  )
    .split('\0')
    .filter(Boolean);
  if (changed.some((path) => !conflicts.has(path)))
    throw new Error('Resolution changes files outside conflicted paths');
  const read = (sha, path) => command('git', ['show', `${sha}:${path}`]).stdout;
  if (
    JSON.parse(read(candidate, 'package.json')).version !== version ||
    JSON.parse(read(resolution, 'package.json')).version !== version
  ) {
    throw new Error('Incorrect root version');
  }
  const candidateNotes = extractChangelogSection(
    read(candidate, 'CHANGELOG.md'),
    version,
  );
  const resolvedChangelog = read(resolution, 'CHANGELOG.md');
  if (
    !candidateNotes ||
    extractChangelogSection(resolvedChangelog, version) !== candidateNotes
  ) {
    throw new Error('Candidate release section was not preserved');
  }
  const mainChangelog = read(main, 'CHANGELOG.md');
  const historyStart = mainChangelog.search(/^##\s+/m);
  if (
    historyStart < 0 ||
    !resolvedChangelog.endsWith(mainChangelog.slice(historyStart))
  ) {
    throw new Error('Published main changelog history was not preserved');
  }
  const files = git(
    'ls-tree',
    '-r',
    '--name-only',
    '-z',
    resolution,
    '--',
    '.changeset',
  ).split('\0');
  if (
    files.some(
      (path) =>
        /^\.changeset\/.*\.md$/i.test(path) &&
        path.toLowerCase() !== '.changeset/readme.md',
    )
  ) {
    throw new Error('Pending changesets in resolution');
  }
  git(
    '-c',
    'core.whitespace=blank-at-eol,blank-at-eof,space-before-tab',
    'diff',
    '--check',
    main,
    resolution,
  );
  const head = git(
    'commit-tree',
    resolvedTree,
    '-p',
    candidate,
    '-p',
    main,
    '-m',
    `Reconcile v${version} with pinned main\n\nReviewed resolution: ${resolution}\nReview PR: ${review.html_url}`,
  );
  const metadata = {
    candidate,
    main,
    resolution,
    reviewUrl: review.html_url,
    head,
  };
  reconciliationBody(promote.body, metadata);

  // Re-read review state and PR identities, then pins immediately before the ordinary FF push.
  reviewed(
    pullRequest(
      reviewBranch,
      releaseBranch,
      resolution,
      candidate,
      review.number,
    ),
  );
  const currentPromote = pullRequest(
    releaseBranch,
    'main',
    candidate,
    main,
    promote.number,
  );
  reconciliationBody(currentPromote.body, metadata);
  pins();
  git('push', 'origin', `${head}:refs/heads/${releaseBranch}`);
  try {
    pins(head);
    const pushedPromote = pullRequest(
      releaseBranch,
      'main',
      head,
      main,
      promote.number,
    );
    // JSON travels over stdin, never through a shell or a candidate-owned file.
    command(
      'gh',
      [
        'api',
        `repos/${repository}/pulls/${promote.number}`,
        '--method',
        'PATCH',
        '--input',
        '-',
      ],
      {
        input: JSON.stringify({
          body: reconciliationBody(pushedPromote.body, metadata),
        }),
      },
    );
  } catch (error) {
    throw new Error(
      `Candidate pushed successfully to ${head}, but Promote PR metadata update failed: ${error.message}`,
    );
  }
  return { head, promoteUrl: promote.html_url, reviewUrl: review.html_url };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (
      process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      process.env.GITHUB_REF !== 'refs/heads/develop'
    ) {
      throw new Error(
        'CLI reconciliation requires a manual GitHub Actions dispatch on develop',
      );
    }
    console.log(
      JSON.stringify(
        reconcileCandidate({
          version: process.env.REQUESTED_VERSION,
          expected_candidate_sha: process.env.EXPECTED_CANDIDATE_SHA,
          expected_main_sha: process.env.EXPECTED_MAIN_SHA,
          resolution_sha: process.env.RESOLUTION_SHA,
        }),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
