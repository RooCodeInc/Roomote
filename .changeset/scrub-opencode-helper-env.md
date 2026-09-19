---
'@roomote/web': patch
---

The OpenCode helper process used for Fast Sessions and helper model calls now receives only the environment it uses: model-provider credentials (including any declared in `R_MODEL_ENV_KEYS`) and the variables passed to it explicitly.
