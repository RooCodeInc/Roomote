---
'@roomote/web': patch
---

Deployments can record answered judgment decisions for building a training set. With `R_JUDGMENT_CAPTURE=on`, every decision a judgment or helper model answers is written, with its state scrubbed of credential shapes and structured personal data, to the deployment's own artifact bucket under `judgment-capture/`. Off by default; it keeps decision text, so it is meant for deployments the operator owns.
