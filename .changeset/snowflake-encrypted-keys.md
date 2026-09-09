---
'@roomote/web': patch
---

Connect to Snowflake with encrypted PKCS8 RSA private keys and a passphrase instead of failing after the connection is saved. Passphrase inputs are masked, invalid keys and connection failures return credential-safe errors, and setup guidance covers secure key generation and staged rotation.
