// Shared GitHub fetch helpers for the get.roomote.dev installer proxy.

const REPO = process.env.ROOMOTE_REPO || 'RooCodeInc/Roomote';
const DEFAULT_REF = process.env.ROOMOTE_DEFAULT_REF || 'develop';

async function fetchGitHub(url, headers = {}) {
  return fetch(url, {
    headers: { 'user-agent': 'get.roomote.dev', ...headers },
  });
}

async function fetchRawFile(ref, filePath) {
  return fetchGitHub(
    `https://raw.githubusercontent.com/${REPO}/${ref}/${filePath}`,
  );
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
  fetchGitHub,
  fetchRawFile,
  sendTextFile,
};
