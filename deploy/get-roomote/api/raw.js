const { fetchRawFile, sendTextFile } = require('./_github');

// Only proxy the deployment files used by the installer and roomote host CLI.
const ALLOWED_PATHS = new Set([
  'deploy/install.sh',
  'deploy/compose/docker-compose.prod.yml',
  'deploy/caddy/Caddyfile',
  'deploy/host/roomote',
]);

module.exports = async (req, res) => {
  const { ref, path } = req.query;
  const filePath = Array.isArray(path) ? path.join('/') : path;

  // Tags and branch names the installer uses (v1.2.3, develop) never contain
  // slashes; rejecting them keeps refs from smuggling extra path segments.
  if (typeof ref !== 'string' || !/^[A-Za-z0-9._-]+$/.test(ref)) {
    res.status(400).send('invalid ref\n');
    return;
  }
  if (!ALLOWED_PATHS.has(filePath)) {
    res.status(404).send('not found\n');
    return;
  }

  const upstream = await fetchRawFile(ref, filePath);
  if (!upstream.ok) {
    res
      .status(upstream.status === 404 ? 404 : 502)
      .send(
        `failed to fetch ${filePath} at ${ref} (upstream ${upstream.status})\n`,
      );
    return;
  }
  sendTextFile(res, await upstream.text(), 3600);
};
