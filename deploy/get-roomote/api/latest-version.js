const { REPO, githubHeaders } = require('./_github');

// Newest-first by numeric version parts; a plain release outranks a
// pre-release suffix on the same version (v1.2.3 > v1.2.3-rc1). GitHub's
// /tags listing is not guaranteed newest-first, so the fallback sorts.
function compareTagsDesc(a, b) {
  const parse = (name) =>
    name.replace(/^v/, '').split('-')[0].split('.').map(Number);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff) return diff;
  }
  return (a.includes('-') ? 1 : 0) - (b.includes('-') ? 1 : 0);
}

// Returns the newest release tag as plain text (e.g. "v0.3.0"), mirroring the
// resolve_latest_version fallback order in deploy/install.sh: the latest
// GitHub release first, then the newest v* tag.
module.exports = async (req, res) => {
  const headers = { ...githubHeaders(), accept: 'application/vnd.github+json' };
  let tag = '';

  const release = await fetch(
    `https://api.github.com/repos/${REPO}/releases/latest`,
    {
      headers,
    },
  );
  if (release.ok) {
    tag = (await release.json()).tag_name || '';
  }

  if (!tag) {
    const tags = await fetch(
      `https://api.github.com/repos/${REPO}/tags?per_page=100`,
      {
        headers,
      },
    );
    if (tags.ok) {
      tag =
        (await tags.json())
          .map((t) => t.name)
          .filter((name) => /^v\d/.test(name))
          .sort(compareTagsDesc)[0] || '';
    }
  }

  if (!tag) {
    res.status(502).send('could not resolve a release tag\n');
    return;
  }

  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader(
    'cache-control',
    'public, s-maxage=300, stale-while-revalidate=3600',
  );
  res.status(200).send(`${tag}\n`);
};
