# TLS trust maintenance

The October 2026 eMudhra incident requires independent updates to language
runtimes and operating-system certificate stores. Updating the host or an SDK
does not update a container's Node, Bun, Python or Go verifier.

## Updated build inputs

- App and contributor/CI Node: **24.22.1**; worker Node: **22.23.4**.
- Worker uv: **0.13.4**; worker and judgment Python certifi: **2026.10.19**;
  pip: **26.2.2** (pip vendors its own certifi copy).
- App/judgment Debian bookworm CA floor: **20250419~deb12u2**.
- Worker Ubuntu 24.04 CA floor: **20260816ubuntu0.24.04.1**.
- Worker runtime schema **5** forces provider artifact names and local image
  compatibility checks to stop reusing the previous runtime generation.

The Node, Ubuntu and Python bases are pinned to multi-architecture registry
indexes verified on 2026-10-22. Package floors fail the build if a stale or
incomplete package mirror cannot supply the incident update. Rebuild images and
record the resulting package versions and image digests before rollout.

References: [incident and downstream fix matrix](https://emudhra.we-have-a-problem.com/),
[Node 24.22.1](https://nodejs.org/en/blog/release/v24.22.1),
[Node 22.23.4](https://nodejs.org/en/blog/release/v22.23.4),
[uv 0.13.4](https://github.com/astral-sh/uv/releases/tag/0.13.4),
[pip 26.2.2](https://github.com/pypa/pip/releases/tag/26.2.2), and
[Ubuntu CA update](https://bugs.launchpad.net/ubuntu/+source/ca-certificates/+bug/2171507).

## Snapshots and persistent tasks

A filesystem snapshot retains its original tools and CA bundles. Uploading a
new worker archive does not replace those tools. The worker installer warns
when Node is below the fixed supported branch floors and continues, so tasks
launched from older snapshots and paused tasks keep working. The daily
environment snapshot refresh rebuilds environment snapshots from the current base
image; custom images and saved task snapshots still need a rebuild or migration.
This check is a Node runtime minimum, **not** an attestation of every trust store
in a snapshot.

Refresh environment snapshots from a rebuilt image. Preserve task work when
migrating saved task snapshots, and separately update/validate their OS CA store,
uv, Python environments and harness binaries. Recreate warm/standby sandboxes;
already-running or reconnecting processes do not automatically execute the new
installer. Custom worker images must also meet the Node minimum.

## Remaining independent mitigation work

These build-input updates are not a claim that every shipped TLS path is fixed:

- **Bun/Brain and OpenCode:** no fixed stable artifact was verified on 2026-10-22.
  The incident matrix still lists Bun as pending. A surrounding Node/OS update
  does not replace OpenCode's embedded verifier. Verify a released fix or a
  reviewed mitigation through each actual fetch/HTTPS/WebSocket path before
  calling these services remediated.
- **MinIO/mc:** the separate published image and sandbox copies still use Go
  1.24.8. Recompile both with Go **1.26.10 or 1.27.3**, regenerate the native
  amd64/arm64 checksum assertions in the Dockerfile and sandbox bootstrap, then
  publish and propagate a new image digest. Do not substitute cross-compiled
  hashes for the native-build pins or disable checksum verification.
- **Caddy, optional infinity and other third-party binaries:** inspect the
  exact image/runtime, select verified fixed replacements and update the catalog
  and deployment pins. No replacement digest is asserted here.
- **Custom CA bundles, repository-installed tools and Python virtualenvs:**
  inspect separately. Do not disable certificate verification after an update.

Use the incident's benign checker through each real deployed verifier without
credentials, including a restored task, and retain a successful ordinary TLS
control. A curl result only tests curl. Deployment inventory, image publication,
snapshot refresh and activation are separate operational steps.
