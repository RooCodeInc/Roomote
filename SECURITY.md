# Security Policy

Please do not report security vulnerabilities through public GitHub issues.

Email security reports to [security@roomote.dev](mailto:security@roomote.dev) with:

- affected version or commit
- a concise description of the issue
- reproduction steps or proof of concept, when available
- any known impact or exposure

We will acknowledge receipt as quickly as practical and coordinate disclosure
once we understand the issue and have a fix path.

We do not currently run a bounty program.

## Scope

Security-sensitive areas include authentication, OAuth callbacks, webhook
verification, task sandbox isolation, secret handling, GitHub/Slack/Linear
integration credentials, and any path that may expose repository contents or
task transcripts.

## Operator Responsibility

Roomote runs agents against repositories and external model providers
chosen by the operator. Operators are responsible for configuring model
provider credentials, GitHub/Slack/Linear applications, public URLs, backups,
and network isolation appropriate for their environment.
