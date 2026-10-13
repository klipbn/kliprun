#!/bin/bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")" && pwd)"
build_dir="$project_dir/.build/local"
app_dir="$project_dir/dist/KlipRun Notifications.app"
sdk_path="$(xcrun --sdk macosx --show-sdk-path)"
target_arch="$(uname -m)-apple-macosx13.0"
mkdir -p "$build_dir" "$app_dir/Contents/MacOS"

# No third-party packages: compile the small core directly into the application.
# This also works with Command Line Tools without a full Xcode installation.
xcrun swiftc -O -sdk "$sdk_path" -target "$target_arch" -parse-as-library \
  -whole-module-optimization -emit-object -emit-module -module-name NotificationCore \
  -emit-module-path "$build_dir/NotificationCore.swiftmodule" \
  -o "$build_dir/NotificationCore.o" "$project_dir"/Sources/NotificationCore/*.swift
xcrun swiftc -O -sdk "$sdk_path" -target "$target_arch" -I "$build_dir" \
  -o "$app_dir/Contents/MacOS/KlipRunNotifications" "$build_dir/NotificationCore.o" \
  "$project_dir"/Sources/KlipRunNotifications/*.swift
cp "$project_dir/Info.plist" "$app_dir/Contents/Info.plist"
codesign --force --sign - "$app_dir"
printf 'Built: %s\n' "$app_dir"
