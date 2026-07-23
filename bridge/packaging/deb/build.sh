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
# per-architecture CLI binaries (@anthropic-ai/claude-agent-sdk-<platform>), keeping this package
# ~4MB and Architecture: all instead of a ~100MB build per arch. The bridge therefore drives the
# Claude Code CLI installed on the host — see src/claude/cliPath.ts and the README Requirements.
echo ">> Installing production dependencies (no dev, no optional: host supplies the Claude CLI)"
cp "$BRIDGE_DIR/package.json" "$PKGTMP/"
[ -f "$BRIDGE_DIR/package-lock.json" ] && cp "$BRIDGE_DIR/package-lock.json" "$PKGTMP/"
( cd "$PKGTMP" && npm install --omit=dev --omit=optional --no-audit --no-fund --loglevel=error >/dev/null )

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

# Pure-JS deps → Architecture: all; if any prebuilt .node binary slipped in, pin to the host arch.
if find "$ROOT/opt/gitview-bridge/node_modules" -name '*.node' -print -quit | grep -q .; then
  ARCH="$(dpkg --print-architecture)"
  sed -i "s/^Architecture: all/Architecture: $ARCH/" "$ROOT/DEBIAN/control"
fi
ARCH="$(awk '/^Architecture:/{print $2}' "$ROOT/DEBIAN/control")"

install -d "$OUT_DIR"
DEB="$OUT_DIR/gitview-bridge_${VERSION}_${ARCH}.deb"
dpkg-deb --root-owner-group --build "$ROOT" "$DEB" >/dev/null
echo ">> Built: $DEB"
dpkg-deb --info "$DEB" | sed -n '1,3p;/Description/,$p'
