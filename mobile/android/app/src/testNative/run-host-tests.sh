#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
android_app_dir="$(cd "${script_dir}/../.." && pwd)"
binary="${TMPDIR:-/tmp}/tapstory-audio-core-tests"

"${CXX:-c++}" \
  -std=c++17 \
  -O2 \
  -pthread \
  -I"${android_app_dir}/src/main/cpp" \
  "${script_dir}/cpp/AudioCoreTests.cpp" \
  -o "${binary}"

"${binary}"
