---
'@roomote/types': patch
'@roomote/db': patch
'@roomote/web': patch
---

Fix the ChatGPT subscription connect dialog waiting forever on a device code that can never succeed. The device-code endpoint returns an `expires_at` roughly fifteen minutes out, but Roomote dropped it and the dialog had no expiry timer, so once a code aged out the dialog kept polling a dead code behind a "Waiting for authorization…" spinner with no way to tell that the code was gone. The dialog now stops at the issuer's stated expiry and prompts for a restart.

Polling also treated every HTTP 403 and 404 from the device-token endpoint as "pending". Only 403 with the structured error code `deviceauth_authorization_pending` actually means the user has not entered the code yet: 404 means the issuer no longer recognizes the code, and a 403 carrying any other code is a refusal that waiting cannot resolve, most commonly an organization policy blocking the OAuth app. Polling now classifies on the structured error code and gives each terminal case its own message, so a blocked deployment says the workspace policy blocks the app and to contact an admin instead of rendering the same spinner as a code nobody has typed in yet. An unrecognized error body still falls back to pending, now bounded by the expiry deadline rather than looping indefinitely.

Rate-limited polls back off instead of failing, and a rejected poll request surfaces its error in the dialog rather than stopping the loop while leaving the promise unhandled.
