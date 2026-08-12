const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');

const { fetchGitHub } = require('../api/_github');

const originalFetch = global.fetch;
const originalToken = process.env.GITHUB_TOKEN;

afterEach(() => {
  global.fetch = originalFetch;
  if (originalToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = originalToken;
  }
});

test('fetches GitHub anonymously', async () => {
  process.env.GITHUB_TOKEN = 'stale-deployment-secret';
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200 };
  };

  const response = await fetchGitHub('https://api.github.com/example', {
    accept: 'application/json',
  });

  assert.equal(response.status, 200);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].options.headers, {
    'user-agent': 'get.roomote.dev',
    accept: 'application/json',
  });
});
