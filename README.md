# Roomote

**A cloud coding agent you deploy in minutes and actually own.**

You give it a task in Slack (or Teams, or Telegram, or Discord). It clones your
repo into an isolated sandbox, writes the code, runs the tests, takes a
screenshot, and opens a PR. You review the diff like you would from any teammate.

No IDE plugin. No terminal session. No babysitting. It works while you do
something else.

```
"Fix the 500 on /api/billing for annual plans"

→ Roomote picks up the task
→ spins up a sandbox with your full repo
→ finds the bug, writes a fix, runs the test suite
→ opens a PR with a screenshot of the working page
→ you review, merge, done
```

Source-available. Self-hostable. Use your ChatGPT subscription or bring your own
API keys.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/Rj2cFo)
&nbsp;&nbsp;
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/RooCodeInc/Roomote)

![Roomote chat workflow demo](assets/roomote-hero.gif)

---

## How it works (60-second mental model)

Roomote is a full-stack application, not an extension or a wrapper. It connects
to the tools you already use and runs agents in throwaway sandboxes.

```
┌────────────────────────────────────────────────────────────────────┐
│  You (in Slack / Teams / Telegram / Discord / Web UI)              │
│  "Add dark mode to the settings page"                              │
└───────────────────────────────┬────────────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│  Roomote                                                           │
│                                                                    │
│    ┌─────────────┐   ┌────────────────┐   ┌──────────────────┐     │
│    │ Your models │   │ Your repo      │   │ Your tools       │     │
│    │ (BYOK)      │   │ (GitHub,       │   │ (Linear, Sentry, │     │
│    │ OpenRouter, │   │  GitLab,       │   │  Notion, Jira,   │     │
│    │ Anthropic,  │   │  Gitea,        │   │  Grafana,        │     │
│    │ OpenAI, …   │   │  Azure DevOps, │   │  PostHog, Figma, │     │
│    │             │   │  Bitbucket)    │   │  etc.)           │     │
│    └──────┬──────┘   └────────┬───────┘   └─────────┬────────┘     │
│           │                   │                     │              │
│           └───────────────────┼─────────────────────┘              │
│                               ▼                                    │
│    ┌─────────────────────────────────────────────────────────┐     │
│    │ Ephemeral sandbox (Modal, E2B, Daytona, Blaxel, Docker) │     │
│    │                                                         │     │
│    │ clone repo → make changes → run tests → screenshot      │     │
│    │ → push branch → open PR                                 │     │
│    └─────────────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
        Pull request with diff, screenshots, and a live preview URL
```

Every task gets its own sandbox. Nothing touches your local machine. The agent
cleans up after itself.

### Supported providers

**Inference:** Two ways to connect models.

1. **ChatGPT subscription.** Already paying for ChatGPT Plus or Pro? Connect
   your account directly. No API key needed, no separate billing. Roomote uses
   the models included in your subscription.
2. **API keys (BYOK).** Paste a key from OpenRouter, Anthropic, OpenAI, xAI,
   Google Gemini, Amazon Bedrock, Vercel AI Gateway,
    Baseten, Together AI, Moonshot AI (Kimi), Kimi for Coding, MiniMax, or OpenCode Zen / Go.

**Sandbox compute:** Modal, E2B, Daytona, Blaxel, and Local Docker.

**Source control:** GitHub, GitLab, Gitea, Azure DevOps, and Bitbucket Cloud.

---

## Five-minute quickstart

Pick one path. You will have a working Roomote instance at the end.

### Option A: One-click deploy (Railway)

1. Click the button:

   [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/Rj2cFo)

2. Railway provisions Postgres, Redis, and the app. Follow the prompts to set
   your admin email and password.

3. Open the setup link Railway gives you. Connect models. Two options:
   - **ChatGPT subscription:** Sign in with your ChatGPT account. If you
     already pay for Plus or Pro, you're done. No API key needed.
   - **API key:** Paste a key from OpenRouter, Anthropic, OpenAI, or any other
     supported provider.

4. Connect source control: GitHub, GitLab, Gitea, Azure DevOps, or Bitbucket
   Cloud.

5. Open Slack, send Roomote a message:

   ```
   What files are in the root of the repo?
   ```

   **Expected output:** Roomote lists your repo's top-level files and asks what
   you'd like to work on.

You now have a working cloud coding agent. Total time: ~3 minutes.

### Option B: One-click deploy (Render)

1. Click the button:

   [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/RooCodeInc/Roomote)

2. Render creates managed Postgres, Redis, and the app. Set your admin
   credentials when prompted.

3. Open the setup link, connect a model provider and source control.

4. Send Roomote a test message in Slack. Same expected output as above.

### Option C: Self-host on your own server

SSH into a fresh Ubuntu/Debian machine (4 GB RAM recommended) and run:

```sh
curl -fsSL https://get.roomote.dev | bash
```

The installer handles Docker, secrets, and the Compose stack. It prints a setup
link when it finishes. Connect your model provider and repo, then send a test
message.

For production, point DNS at your server and pass `--domain roomote.example.com`.

See also: [Coolify](deploy/coolify/README.md) and [Fly.io](deploy/fly/README.md)
deployment guides.

---

## What can it do?

Roomote handles the work that pulls you off your main project:

- **Fix bugs.** Paste an error, a Sentry link, or a stack trace. It reads the
  code, reproduces the issue in its sandbox, writes a fix, and opens a PR.
- **Answer codebase questions.** "How does auth work?" or "Where is the
  billing logic?" It reads the code and gives you a real answer.
- **Handle chores.** Dependency upgrades, linter fixes, config changes,
  migration files, boilerplate.
- **Build small features.** "Add a dark mode toggle to settings." It writes the
  code, runs the app, takes a screenshot, and opens a PR with a preview link.
- **Triage issues.** Connect Linear, Jira, or GitHub Issues. It reads new
  tickets, asks clarifying questions, and starts working.

It connects to dozens of tools (Sentry, Grafana, PostHog, Notion, Figma, and
more) so it can read logs, check dashboards, and pull context without you
copy-pasting.

---

## Why self-host a coding agent?

- **Your code stays on your infrastructure.** No repo access leaves your
  network.
- **Use what you already pay for.** Connect your ChatGPT subscription directly,
  or bring API keys from any supported provider. Switch models per task. No
  markup on tokens.
- **Read every line.** The full source is here. Audit it, extend it, fork it.
- **No per-seat SaaS pricing.** Free for up to 10 users. Need more? Email
  [help@roomote.dev](mailto:help@roomote.dev) for a license.

---

## Teams and organizations

Roomote is multiplayer by default. When someone assigns a task, the whole team
sees the progress and the resulting PR.

Features that matter at scale:

- **Parallel agents.** Run multiple tasks at the same time across different
  repos.
- **Shared context.** Agents learn your codebase conventions, test patterns,
  and deploy process.
- **Audit trail.** Every action is logged: which model was used, what tools
  were called, what code was written.
- **Web UI.** Consumer-grade dashboard for managing tasks, reviewing output,
  and configuring integrations.
- **Live previews.** Agents spin up a preview URL so reviewers can click
  through changes before merging.

### Enterprise

Need SSO, custom SLAs, or dedicated support? Email
[help@roomote.dev](mailto:help@roomote.dev).

Want a managed deployment instead of self-hosting? We can run it for you.
[Get in touch](mailto:help@roomote.dev).

---

## FAQ

**Is Roomote open source?**
It is source-available under the [Fair Core License 1.0](LICENSE) (FCL-1.0-ALv2).
You can read, modify, and self-host the code. Free for up to 10 users. Larger
deployments need a license. Email
[help@roomote.dev](mailto:help@roomote.dev). After the license period, the code
converts to Apache 2.0.

**How is this different from Cursor / Copilot / Claude Code?**
Those are IDE tools that help you write code faster in your editor. Roomote is a
standalone agent: you assign it a task, walk away, and come back to a PR. It
does not require an IDE or a terminal session.

**How is this different from Devin?**
Devin is a closed, hosted product. Roomote is source-available and
self-hostable. You own your data, use your existing ChatGPT subscription or
bring your own API keys, and pick your models. You can read every line of code
it runs.

**What models does it support?**
Two options. Connect your ChatGPT Plus or Pro subscription directly (no API key
needed), or paste an API key from OpenRouter, Anthropic, OpenAI, xAI, Google
Gemini, Amazon Bedrock, Vercel AI Gateway, Baseten,
  Together AI, Moonshot AI (Kimi), Kimi for Coding, MiniMax, or OpenCode Zen / Go.

**What sandboxes does it support?**
Modal, E2B, Daytona, Blaxel, and Local Docker.

**What repos can it access?**
GitHub, GitLab, Gitea, Azure DevOps, and Bitbucket Cloud. Connect one or many.

**What does it cost?**
Self-hosting is free for up to 10 registered users. You pay your own model
provider for tokens (or use the models bundled with your ChatGPT subscription).
For larger teams, licenses are available by emailing
[help@roomote.dev](mailto:help@roomote.dev).

**I already pay for ChatGPT Plus. Do I need an API key too?**
No. Connect your ChatGPT account and you can start using Roomote immediately.
API keys are an alternative for people who want to use other providers or
control costs at the token level.

**Can non-engineers use it?**
Yes. PMs, support, ops, and marketers can assign tasks in Slack without touching
code. "Fix the typo on the pricing page" works.

---

## Documentation

- [Public docs](https://docs.roomote.dev): setup, configuration, integrations
- [Self-hosting guide](SELF_HOSTING.md): DNS, production config, scaling
- [Local development](LOCAL_DEVELOPMENT.md): contributing to Roomote itself

## Community

- [Discord](https://discord.gg/roomote): questions, showcase, feature requests
- [GitHub Issues](https://github.com/RooCodeInc/Roomote/issues): bug reports
  and feature requests

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [CLA](CLA.md).

## Security

Report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

[Fair Core License 1.0 (FCL-1.0-ALv2)](LICENSE). Free for up to 10 users.
Licenses for larger deployments are available by emailing
[help@roomote.dev](mailto:help@roomote.dev). The license key functionality may
not be disabled or circumvented. [TRADEMARKS.md](TRADEMARKS.md) covers trademark
usage.
