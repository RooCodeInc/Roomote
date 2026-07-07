// Shared GitHub fetch helpers for the get.roomote.dev installer proxy.
//
// GITHUB_TOKEN is optional: while the source repo is private, set it to a
// fine-grained PAT scoped to that one repo with Contents: read-only. Once the
// repo is public, remove the token and the proxy keeps working anonymously.

const REPO = process.env.ROOMOTE_REPO || 'RooCodeInc/Roomote';
const DEFAULT_REF = process.env.ROOMOTE_DEFAULT_REF || 'develop';

function githubHeaders() {
  const headers = { 'user-agent': 'get.roomote.dev' };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function fetchRawFile(ref, filePath) {
  return fetch(`https://raw.githubusercontent.com/${REPO}/${ref}/${filePath}`, {
    headers: githubHeaders(),
  });
}

function sendTextFile(res, body, sMaxAgeSeconds) {
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader(
    'cache-control',
    `public, s-maxage=${sMaxAgeSeconds}, stale-while-revalidate=86400`,
  );
  res.status(200).send(body);
}

module.exports = {
  REPO,
  DEFAULT_REF,
  githubHeaders,
  fetchRawFile,
  sendTextFile,
};
