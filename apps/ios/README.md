# Roomote for iOS

Native iOS client for a Roomote deployment: Inbox (questions and approvals
waiting on you), Sessions with live streaming, Tasks with transcripts and
artifacts, push notifications with inline actions, a share extension that
starts a Session from any app, and deep links.

## Screens

The app mirrors the mobile web layout: a 48pt top bar (menu, logo, new
session, search, avatar) above every root screen and a left drawer instead
of a tab bar. The drawer lists New Session, Home, Sessions, Inbox, Tasks,
Automations and Analytics (web-only, opened in Safari), Settings, and the
20 most recent sessions with status dots.

| Screen | What it shows |
| --- | --- |
| Home | "What should Roomote work on?" composer landing; sending starts a Session. |
| Sessions | Filter toolbar with search plus full-bleed rows (owner, title, status, source). |
| Session detail | Sticky header card, transcript (prompt bubbles, assistant text, tool activity, Coding agent cards, pending questions and approvals), composer. |
| Tasks / Task detail | Task rows with environment and model chips; detail with robot avatar header, PRs, artifacts, transcript, and steer composer. |
| Inbox | Pending questions and approvals as cards; the top bar menu shows a badge count. |
| Settings | Profile, Notifications, Deployment cards and Sign out. |

Design tokens (colors, DM Sans / Monaspace fonts, radii, icon mapping) live in
`Roomote/Theme/RoomoteTheme.swift` and follow the web app's light and dark
themes.

The app talks to the JSON API described in [`docs/api-v1.md`](docs/api-v1.md).
That document is the contract between this app and the server.

## Per-deployment build model

Each Roomote deployment builds and ships its own copy of this app, the same
way each deployment creates its own Slack app. There is no shared App Store
listing: the bundle id, display name, Apple team, deployment URL, and
associated domains are all read from `roomote-ios.json` at generate time and
baked into the binary. The app then only ever talks to that deployment
(the Sign in screen has an "Advanced" override for testing).

Everything a deployment needs lives in this directory:

| Path | What it is |
| --- | --- |
| `roomote-ios.example.json` | Template for the per-deployment config. Copy to `roomote-ios.json` (gitignored). |
| `project.yml` | [XcodeGen](https://github.com/yonaskolb/XcodeGen) project definition. `Roomote.xcodeproj` is generated and not committed. |
| `scripts/configure.sh` | Reads `roomote-ios.json`, writes `Config/Deployment.xcconfig` and `Config/Generated/*.entitlements`. |
| `scripts/release.sh` | Archive + upload to TestFlight with an App Store Connect API key. |
| `RoomoteKit/` | Shared Swift package: API client, models, Keychain, SSE, deep links, push payloads. Used by all three targets. |
| `Roomote/` | The app (SwiftUI, iOS 17+). |
| `RoomoteShare/` | Share extension (URLs, text, images -> new Session). |
| `RoomoteNotificationService/` | Notification service extension (pass-through today; image attachments are a TODO). |

## Requirements

- Xcode 16.4 (Swift 6.1), iOS 17 deployment target
- `xcodegen` (`brew install xcodegen`)
- `jq` is used by `configure.sh` when present; it falls back to `python3`
- An Apple Developer team for device builds and TestFlight (not needed for the simulator)

## Configure

```sh
cd apps/ios
cp roomote-ios.example.json roomote-ios.json
```

Edit `roomote-ios.json`:

```json
{
  "bundleId": "com.example.roomote",
  "teamId": "ABCDE12345",
  "displayName": "Roomote",
  "deploymentUrl": "https://roo.example.com",
  "associatedDomains": ["roo.example.com"]
}
```

- `bundleId`: the app's bundle id. The extensions use `<bundleId>.share` and
  `<bundleId>.notification-service`; the Keychain access group is
  `<TeamID>.<bundleId>.shared` and the app group is `group.<bundleId>`.
- `teamId`: Apple Developer Team ID. Leave empty for simulator-only builds.
- `deploymentUrl`: the deployment's app URL (`R_APP_URL`). It is written into
  the xcconfig as `https:/$()/host` because `//` starts a comment in xcconfig
  files; Xcode resolves it back to `https://host` in Info.plist.
- `associatedDomains`: hosts for universal links (`https://<host>/sessions/<id>`,
  `/task/<id>`). Each entry becomes `applinks:<host>` in the entitlements. The
  deployment must serve the matching `apple-app-site-association` file.

`scripts/configure.sh` runs automatically before every `xcodegen generate`
(via `preGenCommand`), and can be run on its own. It never edits
`project.yml`; all per-deployment values flow through the generated xcconfig
and entitlements.

## Generate and run in the simulator

```sh
cd apps/ios
xcodegen generate          # runs scripts/configure.sh first
open Roomote.xcodeproj     # pick the Roomote scheme and an iPhone simulator
```

Or from the command line:

```sh
xcodebuild -project Roomote.xcodeproj -scheme Roomote \
  -destination 'generic/platform=iOS Simulator' -configuration Debug \
  CODE_SIGNING_ALLOWED=NO build
```

For local development against `pnpm dev`, keep `deploymentUrl` at
`http://localhost:3000`; the Info.plist allows local networking. To point a
simulator build at another host without rebuilding, expand "Advanced" on the
Sign in screen.

Push notifications do not work in the simulator; everything else does.

Unsigned simulator builds (`CODE_SIGNING_ALLOWED=NO`) have no Keychain
entitlement, so `SessionStore` keeps the token in the shared defaults there
instead. Debug builds also read two launch environment variables so the app
can be driven from the shell without tapping through Safari's
"Open in Roomote?" prompt:

```sh
# Sign in with a one-time code from /api/auth/mobile-handoff
SIMCTL_CHILD_ROOMOTE_DEV_AUTH_CODE=<code> xcrun simctl launch <udid> <bundle id>
# Open a screen or a route on launch
SIMCTL_CHILD_ROOMOTE_DEV_SCREEN=sessions|inbox|tasks|settings|search|drawer \
SIMCTL_CHILD_ROOMOTE_DEV_ROUTE=session:<id>|task:<id> xcrun simctl launch <udid> <bundle id>
```

## Tests

RoomoteKit has host-runnable unit tests (date decoding, message text
extraction, pending-request detection, deep link parsing, SSE parsing):

```sh
cd apps/ios/RoomoteKit
swift test
```

## Ship to TestFlight

`scripts/release.sh` runs configure, regenerates the project, archives a
Release build, and uploads it to App Store Connect with automatic signing.

1. Create an App Store Connect API key (Users and Access > Integrations >
   App Store Connect API) with the App Manager role and download the `.p8`.
2. Make sure `teamId` is set in `roomote-ios.json`.
3. Run:

```sh
export ASC_KEY_ID=ABC123DEF4
export ASC_ISSUER_ID=00000000-0000-0000-0000-000000000000
export ASC_KEY_PATH=$HOME/.appstoreconnect/AuthKey_ABC123DEF4.p8
cd apps/ios && scripts/release.sh
```

`-allowProvisioningUpdates` lets Xcode register the App ID, enable the push,
app group, keychain sharing, and associated domains capabilities, and create
the distribution profile on first run. The build number defaults to a UTC
timestamp; override it with `BUILD_NUMBER`. The first upload for a new bundle
id also needs the app record created in App Store Connect (the export step
tells you if it is missing).

Once the build finishes processing, add testers in TestFlight. **TestFlight
builds expire 90 days after upload**, so each deployment should re-run
`release.sh` at least every three months (a scheduled job works well) or
testers will be locked out until a new build lands.

## Push notifications (APNs)

The server sends pushes through the deployment's APNs key. Create a key in
Apple Developer > Keys with the Apple Push Notifications service enabled,
then enter the Key ID, Team ID, and the `.p8` contents in the deployment
under **Settings > iOS app** together with the bundle id from
`roomote-ios.json`. Debug builds register with environment `sandbox` and
Release builds with `production`; the server picks the matching APNs host.

Notification categories and their actions:

| Category | Actions |
| --- | --- |
| `USER_INPUT` | `REPLY` (text input, answers the single free-text question) and `OPEN` |
| `CAPABILITY_OFFER` | `APPROVE`, `DECLINE`, `OPEN` |
| `TASK_SETTLED`, `REPLY` | `OPEN` |

Approve, Decline, and Reply run in the background using the shared Keychain
token; tapping the notification follows `data.url`.

## Deep links

- `roomote://sessions/<id>` and `roomote://tasks/<id>` open the matching screen.
- `roomote://auth?code=...` completes the browser sign-in handoff.
- `https://<deployment host>/sessions/<id>` and `/task/<id>` work as universal
  links when the host is listed in `associatedDomains`.

## Layout

```
Roomote/
  App/          entry point, AppModel, Router, AppShell (top bar + drawer), push registration
  Theme/        RoomoteTheme design tokens, fonts, icon mapping
  Components/   shared views (question form, offer form, composer, cards, states)
  Features/     Auth, Home, Inbox, Sessions, Tasks, Settings
RoomoteKit/     shared package (see above) + unit tests
RoomoteShare/   share extension
RoomoteNotificationService/
Config/         generated xcconfig + entitlements (gitignored)
scripts/        configure.sh, release.sh
docs/           API contract
```
