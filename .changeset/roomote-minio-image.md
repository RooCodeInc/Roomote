---
"@roomote/api": patch
---

Deployments now run MinIO from Roomote's own `ghcr.io/roocodeinc/roomote-minio` image, built from the final MinIO community source release, instead of the retired upstream images. The same image provides the `mc` client used to create the artifact bucket, so the separate `minio/mc` image is gone. Existing `/data` volumes are unaffected.
