---
'@roomote/web': major
---

Manage inbound MCP client authorizations from personal settings and, for admins, by user in users settings, including revoking all of a user's clients. Revocation now blocks already-issued OAuth access tokens on subsequent requests.

**Breaking upgrade compatibility:** legacy already-issued MCP access tokens without client/grant identity are rejected with 401 once the new API enforcement is deployed. Deploy the new web token issuer and drain all old issuer instances **before** deploying API enforcement. Live legacy refresh sessions are automatically backfilled, and existing refresh tokens can obtain tracked access tokens while preserving the original remaining session lifetime. Clients without a usable refresh session, or unable to recover by refreshing after a 401, must reconnect and repeat browser consent. In-progress legacy authorization codes must repeat consent too. Redis authorization data must remain available; missing data cannot be backfilled. Rolling back the API removes prompt revocation enforcement, and rolling back the issuer may require reconnecting migrated clients.
