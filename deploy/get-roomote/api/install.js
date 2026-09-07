const { DEFAULT_REF, fetchRawFile, sendTextFile } = require('./_github');

// Serves deploy/install.sh from the default branch so
// `curl -fsSL https://get.roomote.dev | sudo bash` works.
module.exports = async (req, res) => {
  const upstream = await fetchRawFile(DEFAULT_REF, 'deploy/install.sh');
  if (!upstream.ok) {
    res
      .status(502)
      .send(`failed to fetch install.sh (upstream ${upstream.status})\n`);
    return;
  }
  sendTextFile(res, await upstream.text(), 300);
};
