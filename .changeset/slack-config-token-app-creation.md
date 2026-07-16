---
'@roomote/web': minor
---

Slack setup can now create the Slack app for you: paste an app configuration
token and Roomote creates the app through Slack's `apps.manifest.create` API,
saves the client ID, client secret, and signing secret automatically, and
advances straight to the Connect to Slack install step. Entering values
manually and the prefilled-manifest path remain available as fallbacks, and
the mock Slack harness now covers `apps.manifest.create` so the flow is
testable without a real workspace.
