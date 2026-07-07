# get.roomote.dev installer proxy

A minimal Vercel project that serves the one-command installer at
`https://get.roomote.dev` and proxies the handful of GitHub fetches the
installer and the `roomote` host CLI make, so installs work even while the
source repository is private.

## Endpoints

| Route                 | Serves                                                     |
| --------------------- | ---------------------------------------------------------- |
| `/` and `/install.sh` | `deploy/install.sh` from the default branch (`text/plain`) |
| `/latest-version`     | The newest release tag as plain text, e.g. `v0.3.0`        |
| `/raw/<ref>/<path>`   | Allowlisted deployment files at a git ref (tag or branch)  |

The `/raw` allowlist in [`api/raw.js`](api/raw.js) covers exactly what
`install.sh` and `roomote upgrade` fetch: `deploy/install.sh`,
`deploy/compose/docker-compose.prod.yml`, `deploy/caddy/Caddyfile`, and
`deploy/host/roomote`. Nothing else in the repo is reachable through the
proxy.

Both scripts treat `https://get.roomote.dev` as a mirror tried first, with
direct GitHub as the fallback, so a proxy outage degrades to today's behavior
(which requires the repo to be public or `GITHUB_TOKEN` to be set).

## Environment variables

| Variable              | Required                  | Purpose                                                                                                                                                  |
| --------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`        | while the repo is private | Fine-grained PAT scoped to the source repo only, permission **Contents: read-only**. Remove once the repo is public; the proxy then fetches anonymously. |
| `ROOMOTE_REPO`        | no                        | Source repo override (default `RooCodeInc/Roomote`)                                                                                                  |
| `ROOMOTE_DEFAULT_REF` | no                        | Branch served at `/` (default `develop`)                                                                                                                 |

## Deploying

One-time setup:

1. `cd deploy/get-roomote && vercel deploy --prod` (creates the project on
   first run), or create a Vercel project with this directory as the root.
2. In the Vercel project settings, add the `get.roomote.dev` domain (DNS is
   already on Vercel, so this is just the domain assignment).
3. Set `GITHUB_TOKEN` in the project's environment variables.

There is no build step and no dependencies; the three functions run on
Vercel's Node runtime with the built-in `fetch`.

Smoke test after deploying:

```sh
curl -fsSL https://get.roomote.dev | head -5
curl -fsSL https://get.roomote.dev/latest-version
curl -fsSL https://get.roomote.dev/raw/develop/deploy/caddy/Caddyfile | head -5
curl -sS -o /dev/null -w '%{http_code}\n' https://get.roomote.dev/raw/develop/README.md   # 404 (not allowlisted)
```

## Caching

Responses are cached at Vercel's edge (`s-maxage`): the installer and
`/latest-version` for 5 minutes, `/raw` files for 1 hour. A new release is
therefore visible to installs within 5 minutes with no redeploy of this
project.
