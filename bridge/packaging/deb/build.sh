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
PARCEL_VERSION="$(node -p "require('$BRIDGE_DIR/package.json').dependencies['@parcel/watcher'].replace(/^[^0-9]*/, '')")"
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

echo ">> Assembling package root"
ROOT="$STAGE/root"
install -d "$ROOT/DEBIAN" "$ROOT/opt/gitview-bridge/bin" "$ROOT/usr/bin" \
          "$ROOT/etc/gitview-bridge" "$ROOT/etc/default" "$ROOT/lib/systemd/system"
cp -r "$BRIDGE_DIR/dist" "$ROOT/opt/gitview-bridge/"
cp -r "$PKGTMP/node_modules" "$ROOT/opt/gitview-bridge/"
cp "$BRIDGE_DIR/package.json" "$ROOT/opt/gitview-bridge/"
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
