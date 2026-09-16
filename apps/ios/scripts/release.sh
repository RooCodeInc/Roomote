#!/usr/bin/env bash
# Builds a Release archive of the per-deployment app and uploads it to
# TestFlight through App Store Connect.
#
# Required environment:
#   ASC_KEY_ID      App Store Connect API key id
#   ASC_ISSUER_ID   App Store Connect API issuer id
#   ASC_KEY_PATH    path to the AuthKey_<KEY_ID>.p8 file
# Optional:
#   BUILD_NUMBER    CFBundleVersion for this upload (default: UTC timestamp)
#   ROOMOTE_IOS_CONFIG  alternative roomote-ios.json path
#
# The key needs the App Manager role (or Developer + access to the app) so
# that -allowProvisioningUpdates can create/refresh the App ID, push
# certificate, and distribution profile automatically.
set -euo pipefail

: "${ASC_KEY_ID:?ASC_KEY_ID is required}"
: "${ASC_ISSUER_ID:?ASC_ISSUER_ID is required}"
: "${ASC_KEY_PATH:?ASC_KEY_PATH is required}"
if [[ ! -f "$ASC_KEY_PATH" ]]; then
  echo "release: ASC_KEY_PATH '$ASC_KEY_PATH' does not exist" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

scripts/configure.sh
xcodegen generate

TEAM_ID="$(sed -n 's/^DEVELOPMENT_TEAM = //p' Config/Deployment.xcconfig | tr -d '[:space:]')"
if [[ -z "$TEAM_ID" ]]; then
  echo "release: teamId in roomote-ios.json is required to sign a release build" >&2
  exit 1
fi

BUILD_NUMBER="${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}"
BUILD_DIR="build"
ARCHIVE_PATH="$BUILD_DIR/Roomote.xcarchive"
EXPORT_PATH="$BUILD_DIR/export"
EXPORT_OPTIONS="$BUILD_DIR/ExportOptions.plist"
mkdir -p "$BUILD_DIR"

AUTH_ARGS=(
  -allowProvisioningUpdates
  -authenticationKeyID "$ASC_KEY_ID"
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"
  -authenticationKeyPath "$ASC_KEY_PATH"
)

echo "release: archiving build $BUILD_NUMBER for team $TEAM_ID"
xcodebuild archive \
  -project Roomote.xcodeproj \
  -scheme Roomote \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE_PATH" \
  "${AUTH_ARGS[@]}" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  CODE_SIGN_STYLE=Automatic

cat > "$EXPORT_OPTIONS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>upload</string>
	<key>teamID</key>
	<string>$TEAM_ID</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>uploadSymbols</key>
	<true/>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
</dict>
</plist>
PLIST

echo "release: uploading to TestFlight"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -exportPath "$EXPORT_PATH" \
  "${AUTH_ARGS[@]}"

echo "release: upload complete (build $BUILD_NUMBER). Processing takes a few minutes in App Store Connect."
