#!/bin/sh
#
# Compile MD4C to WebAssembly for the browser.
#
# Uses plain clang targeting wasm32 together with the tiny libc in
# wasm/libc/, so no Emscripten or WASI SDK is required. Any clang >= 11 with
# the WebAssembly backend and wasm-ld (from lld) works:
#
#   Debian/Ubuntu:  apt install clang lld
#   macOS:          brew install llvm lld
#
# Usage:  wasm/build.sh [output.wasm]      (default: wasm/dist/md4c.wasm)
#
# Environment overrides: CC, OPTFLAGS.

set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
OUT=${1:-"$HERE/dist/md4c.wasm"}
CC=${CC:-clang}
OPTFLAGS=${OPTFLAGS:--O2}

mkdir -p "$(dirname "$OUT")"

# shellcheck disable=SC2086
"$CC" \
    --target=wasm32-unknown-unknown \
    -std=c99 $OPTFLAGS \
    -nostdlib -ffreestanding -fno-builtin \
    -fvisibility=hidden \
    -isystem "$HERE/libc/include" \
    -I "$ROOT/src" \
    -DMD4C_USE_UTF8 \
    -Wall -Wno-unused-function \
    -Wl,--no-entry \
    -Wl,--strip-all \
    -Wl,-z,stack-size=1048576 \
    -o "$OUT" \
    "$ROOT/src/md4c.c" \
    "$ROOT/src/entity.c" \
    "$HERE/md4c_wasm.c" \
    "$HERE/libc/libc.c"

echo "Built $OUT ($(wc -c < "$OUT") bytes)"
