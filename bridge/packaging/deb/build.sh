#!/usr/bin/env bash
# Build the gitview-bridge .deb. Requires: node/npm (to compile + fetch prod deps),
# dpkg-deb. Usage: ./build.sh [OUT_DIR]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="$(cd "$HERE/../.." && pwd)"
VERSION="$(node -p "require('$BRIDGE_DIR/package.json').version")"
OUT_DIR="${1:-$BRIDGE_DIR/build/deb}"

STAGE="$(mktemp -d)"; PKGTMP="$(mktemp -d)"
trap 'rm -rf "$STAGE" "$PKGTMP"' EXIT

echo ">> Compiling bridge (tsc)"
( cd "$BRIDGE_DIR" && npm run build >/dev/null )

# --omit=optional deliberately drops BOTH the 14MB sandbox-runtime and the Agent SDK's ~222MB
# per-architecture CLI binaries (@anthropic-ai/claude-agent-sdk-<platform>), keeping this package small.
# The bridge therefore drives the Claude Code CLI installed on the host — see src/claude/cliPath.ts and
# the README Requirements.
echo ">> Installing production dependencies (no dev, no optional: host supplies the Claude CLI)"
cp "$BRIDGE_DIR/package.json" "$PKGTMP/"
[ -f "$BRIDGE_DIR/package-lock.json" ] && cp "$BRIDGE_DIR/package-lock.json" "$PKGTMP/"
( cd "$PKGTMP" && npm install --omit=dev --omit=optional --no-audit --no-fund --loglevel=error >/dev/null )

# …but @parcel/watcher ships its native binding AS an optional dependency, so the blanket --omit above
# silently produced a package whose watcher throws on require: "No prebuild or local build of
# @parcel/watcher found". It installed fine and simply never reported a file change. Pull back exactly
# the one platform binary we need, which is also what makes this package arch-specific (see below).
# Read the version npm actually RESOLVED, not the range in package.json: with "^2.6.0" npm may install
# 2.6.1, and packing 2.6.0's binding beside 2.6.1's JavaScript is a version skew nobody would look for.
PARCEL_VERSION="$(node -p "require('$PKGTMP/node_modules/@parcel/watcher/package.json').version")"
case "${TARGET_ARCH:-$(dpkg --print-architecture)}" in
  amd64) PARCEL_PLATFORM="linux-x64-glibc" ;;
  arm64) PARCEL_PLATFORM="linux-arm64-glibc" ;;
  armhf) PARCEL_PLATFORM="linux-arm-glibc" ;;
  *) echo "build: no @parcel/watcher prebuild known for ${TARGET_ARCH:-$(dpkg --print-architecture)}" >&2; exit 1 ;;
esac
echo ">> Adding the native watcher binding for $PARCEL_PLATFORM"
# Fetched with `npm pack`, not `npm install`, for two independent reasons:
#
#  1. CROSS-BUILD. The platform packages declare {os, cpu, libc}, and `npm install` refuses one that does
#     not match the host — EBADPLATFORM — so an arm64 .deb could never be built on this amd64 box.
#     `--cpu`/`--os` do not override that check. `npm pack` performs no validation: it just downloads the
#     tarball, and the binary inside is a real aarch64 ELF.
#  2. NO TREE RE-RESOLUTION. `npm install <pkg>` re-resolves everything and quietly drags back what the
#     previous step omitted — measured at 463MB of Agent SDK binaries plus dev deps, turning a 3.6MB
#     package into 115MB. Unpacking a tarball touches nothing else.
PARCEL_DIR="$PKGTMP/node_modules/@parcel/watcher-$PARCEL_PLATFORM"
echo ">> Fetching the $PARCEL_PLATFORM watcher binding (npm pack: no platform gate, no re-resolution)"
mkdir -p "$PARCEL_DIR"
( cd "$STAGE" && npm pack --loglevel=error "@parcel/watcher-$PARCEL_PLATFORM@$PARCEL_VERSION" >/dev/null )
tar xzf "$STAGE/parcel-watcher-$PARCEL_PLATFORM-$PARCEL_VERSION.tgz" -C "$PARCEL_DIR" --strip-components=1
[ -f "$PARCEL_DIR/watcher.node" ] || { echo "build: no watcher.node for $PARCEL_PLATFORM" >&2; exit 1; }

# ---- the KiCad mesh converter (ADR-040) -------------------------------------------------------------
# Shipped so the bridge can convert a board's 3D models when it is opened, instead of an operator having
# to know their own boards' models in advance and run a CLI by hand. Without this, `findConverter` reports
# `unavailable` on every install and on-demand conversion — which is merged and tested — does nothing at
# all on real hardware.
#
# This does NOT breach "no CAD kernel in the bridge". That rule is about the serving *process*: the bridge
# never loads OCCT, it spawns this as a separate program and reads what it leaves behind.
#
# Size: the OCCT WASM is the bulk of it and compresses well, so the package goes from ~3.9MB to ~6MB.
echo ">> Compiling the mesh converter (tsc)"
MODELS_SRC="$(cd "$BRIDGE_DIR/../tools/gitview-models" && pwd)"
# `npm ci`, not `npm install`: it never rewrites package-lock.json, so a release build cannot leave the
# tree it was cut from dirty. And `dist` is cleaned first — tsc does not remove stale output, so an emit
# from an earlier source layout would be copied into the package verbatim and the guards below would
# still pass, because they only check that the expected files exist.
rm -rf "$MODELS_SRC/dist"
if [ -f "$MODELS_SRC/package-lock.json" ]; then
  ( cd "$MODELS_SRC" && npm ci --no-audit --no-fund --loglevel=error >/dev/null )
else
  ( cd "$MODELS_SRC" && npm install --no-audit --no-fund --no-save --loglevel=error >/dev/null )
fi
( cd "$MODELS_SRC" && npx tsc -p tsconfig.json >/dev/null )

echo ">> Installing the converter's production dependencies"
MODTMP="$(mktemp -d)"; trap 'rm -rf "$STAGE" "$PKGTMP" "$MODTMP"' EXIT
cp "$MODELS_SRC/package.json" "$MODTMP/"
[ -f "$MODELS_SRC/package-lock.json" ] && cp "$MODELS_SRC/package-lock.json" "$MODTMP/"
# `--omit=dev`: typescript and @types/node are build-time only. occt-import-js and fzstd are the payload.
( cd "$MODTMP" && npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null )

echo ">> Assembling package root"
ROOT="$STAGE/root"
install -d "$ROOT/DEBIAN" "$ROOT/opt/gitview-bridge/bin" "$ROOT/usr/bin" \
          "$ROOT/etc/gitview-bridge" "$ROOT/etc/default" "$ROOT/lib/systemd/system"
cp -r "$BRIDGE_DIR/dist" "$ROOT/opt/gitview-bridge/"
cp -r "$PKGTMP/node_modules" "$ROOT/opt/gitview-bridge/"
cp "$BRIDGE_DIR/package.json" "$ROOT/opt/gitview-bridge/"

# The converter, beside the bridge's dist — `findConverter` probes `../../models/cli.js` relative to
# `dist/kicad`, which is exactly here. Its compiled tree carries its own copy of the bridge's KiCad
# readers (its tsconfig roots at the repo so `../../../bridge/src/kicad/*.js` keeps resolving), so it is
# self-contained and cannot drift against a half-upgraded bridge mid-install.
install -d "$ROOT/opt/gitview-bridge/models"
cp -r "$MODELS_SRC/dist/." "$ROOT/opt/gitview-bridge/models/"
cp -r "$MODTMP/node_modules" "$ROOT/opt/gitview-bridge/models/"
cp "$MODELS_SRC/package.json" "$ROOT/opt/gitview-bridge/models/"
# A one-line entry point at the path the bridge probes. The emitted CLI sits several directories down
# (`tools/gitview-models/src/cli.js`, because the tsconfig roots at the repo), and a shim is clearer than
# either flattening the tree — which would break the relative imports — or teaching the bridge that path.
cat > "$ROOT/opt/gitview-bridge/models/cli.js" <<'SHIM'
// Entry point for the KiCad mesh converter. The compiled CLI lives deeper in this tree because its
// TypeScript project roots at the repository, so that its imports of the bridge's own KiCad readers
// resolve unchanged. The bridge spawns THIS path — see findConverter in kicad/meshBuilder.
import "./tools/gitview-models/src/cli.js";
SHIM
[ -f "$ROOT/opt/gitview-bridge/models/tools/gitview-models/src/cli.js" ] || {
  echo "build: the converter did not compile to the expected path" >&2; exit 1; }
[ -d "$ROOT/opt/gitview-bridge/models/node_modules/occt-import-js" ] || {
  echo "build: the converter is missing its CAD kernel — it would fail on every model" >&2; exit 1; }
# Modes explicitly, because this is the one part of the package copied with `cp` rather than placed with
# `install -m`: without it the tree inherits the build box's umask, and on a builder with `umask 077` it
# ships mode 0600 root-owned. `findConverter` would still see a regular file and spawn it, so the bridge
# would report repeated build failures rather than the honest `unavailable`.
chmod -R a+rX "$ROOT/opt/gitview-bridge/models"
install -m 0755 "$HERE/gitview-bridge.launcher" "$ROOT/opt/gitview-bridge/bin/gitview-bridge"
install -m 0755 "$HERE/gitview-bridgectl" "$ROOT/usr/bin/gitview-bridgectl"
install -m 0644 "$HERE/gitview-bridge.service" "$ROOT/lib/systemd/system/gitview-bridge.service"
install -m 0644 "$HERE/config.yaml" "$ROOT/etc/gitview-bridge/config.yaml"
install -m 0644 "$HERE/default.env" "$ROOT/etc/default/gitview-bridge"
install -m 0644 "$HERE/conffiles" "$ROOT/DEBIAN/conffiles"
for s in postinst prerm postrm; do install -m 0755 "$HERE/$s" "$ROOT/DEBIAN/$s"; done
sed "s/@VERSION@/$VERSION/" "$HERE/control.in" > "$ROOT/DEBIAN/control"

# The package used to be Architecture: all because every dependency was pure JS. The native watcher ends
# that: a .node binary is arch-specific, so the control file must say so or dpkg will happily install an
# amd64 build on arm64 and the bridge will fail at runtime instead of at install time.
if find "$ROOT/opt/gitview-bridge/node_modules" -name '*.node' -print -quit | grep -q .; then
  sed -i "s/^Architecture: all/Architecture: ${TARGET_ARCH:-$(dpkg --print-architecture)}/" "$ROOT/DEBIAN/control"
else
  echo "build: expected a native watcher binding but found none — the package would not watch files" >&2
  exit 1
fi
ARCH="$(awk '/^Architecture:/{print $2}' "$ROOT/DEBIAN/control")"

install -d "$OUT_DIR"
DEB="$OUT_DIR/gitview-bridge_${VERSION}_${ARCH}.deb"
dpkg-deb --root-owner-group --build "$ROOT" "$DEB" >/dev/null
echo ">> Built: $DEB"
dpkg-deb --info "$DEB" | sed -n '1,3p;/Description/,$p'
