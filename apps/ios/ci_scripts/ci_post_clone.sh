#!/bin/sh
# Xcode Cloud runs this right after it clones the repository (Plan 28). The Xcode project is generated
# from project.yml and never committed, so it is generated here, with the XcodeGen the project is kept
# on. The download is checked against its hash before it runs. RealmKit's committed Package.resolved
# pins the Swift packages, which is all Xcode Cloud needs to resolve them.
set -eu

XCODEGEN_VERSION=2.44.1
XCODEGEN_SHA256=a2e905fb68446e9bb4008cdfe2e13e3f176d0cbcca828b71770f8e53fca91b73

tools=$(mktemp -d)
curl -fsSL --retry 3 "https://github.com/yonaskolb/XcodeGen/releases/download/$XCODEGEN_VERSION/xcodegen.zip" -o "$tools/xcodegen.zip"
echo "$XCODEGEN_SHA256  $tools/xcodegen.zip" | shasum -a 256 -c -
unzip -q "$tools/xcodegen.zip" -d "$tools"
"$tools/xcodegen/bin/xcodegen" generate --spec "$CI_PRIMARY_REPOSITORY_PATH/apps/ios/project.yml"
