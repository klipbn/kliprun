#!/bin/bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")" && pwd)"
build_dir="$project_dir/.build/local"
bash "$project_dir/build.sh"
xcrun swiftc -parse-as-library -I "$build_dir" -o "$build_dir/window-drag-test" \
  "$build_dir/NotificationCore.o" \
  "$project_dir/Sources/KlipRunNotifications/NotificationView.swift" \
  "$project_dir/Tests/WindowDragging.swift"
"$build_dir/window-drag-test"
