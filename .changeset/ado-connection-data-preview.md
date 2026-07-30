---
'@roomote/ado': patch
'@roomote/sdk': patch
---

Request Azure DevOps `/_apis/connectionData` with api-version `7.1-preview`. The resource is preview-only, so the plain `7.1` version always failed with a 400, which silently disabled Roomote's own-comment detection on Azure DevOps pull request and work item comments and broke approve/request-changes reviewer votes on pull requests.
