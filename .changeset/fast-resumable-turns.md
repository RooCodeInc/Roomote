---
'@roomote/web': patch
---

Fast turns interrupted by a service restart now resume automatically even after they have started tasks or taken other actions, instead of asking the user to send the request again. The resumed run is told what the earlier attempt already did so it continues from there, and a repeated task launch returns the existing task rather than starting a second one.
