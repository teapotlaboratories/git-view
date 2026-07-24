#!/usr/bin/env bash
#
# Build (and optionally publish) a GitView release: the host bridge .deb and the signed Android .apk.
#
# It compiles the bridge into a .deb, assembles the release-signed .apk, verifies the APK's signature,
# writes a SHA256SUMS over both, and — with --publish — creates a GitHub release with the three assets.
# Re-runnable: everything lands in a clean output dir (default: dist/).
#
#   tools/release.sh                 # build both, verify, checksum → dist/   (no publish)
#   tools/release.sh --publish       # …then create the GitHub release v<version>
#   tools/release.sh --apk-only      # just the .apk (e.g. to re-test a signing change)
#   tools/release.sh --publish --notes RELEASE_NOTES.md --tag v0.1.5
#
# Run  tools/release.sh --help  for all options.
#
# Requirements: node + dpkg-deb (deb), a JDK 17 + Android SDK build-tools (apk), and
# android/keystore.properties present so the .apk is release-signed. gh (authenticated) only for --publish.
#
set -euo pipefail

# --- locate the repo (this script lives in <root>/tools) ------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# --- defaults (all overridable by flag or environment) --------------------------------------------
OUT_DIR="${OUT_DIR:-$ROOT/dist}"
BUILD_DEB=1
BUILD_APK=1
PUBLISH=0
DRAFT=0
PRERELEASE=0
CLOBBER=0
ASSUME_YES=0
SKIP_VERSION_CHECK=0
TAG=""
TARGET="${GITVIEW_RELEASE_TARGET:-main}"
NOTES_FILE=""

# Tooling — env overrides win, then sensible local defaults.
JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
GH_BIN="${GH:-gh}"
# Signing. The default keystore.properties (gitignored) holds the .jks path + passwords/alias.
# --keystore / --keystore-props can point elsewhere; secrets are never placed on the command line
# (they stay inside the properties file, passed to Gradle via the GITVIEW_KEYSTORE_PROPS env).
DEFAULT_KEYSTORE_PROPS="$ROOT/android/keystore.properties"
KEYSTORE_FILE=""          # --keystore PATH: a .jks to use (passwords + alias still from the default file)
KEYSTORE_PROPS_FILE=""    # --keystore-props PATH: a self-contained alternate keystore.properties

die() { echo "release: $*" >&2; exit 1; }
step() { echo; echo ">> $*"; }

usage() {
  cat <<'EOF'
release.sh — build (and optionally publish) a GitView release.

DESCRIPTION
  Builds both shippable artifacts from the current tree, in lockstep:
    • gitview-bridge_<version>_all.deb  — the host bridge
    • gitview-<version>.apk             — the Android app, RELEASE-SIGNED
  Then verifies the APK signature (printing the cert SHA-256, which must match the README),
  writes SHA256SUMS, and — with --publish — creates a GitHub release with all three assets.
  Everything lands in a clean output dir (default: dist/), so it is safe to re-run.

USAGE
  tools/release.sh [options]

EXAMPLES
  tools/release.sh                              # build both → dist/, verify, checksum (no publish)
  tools/release.sh --publish                    # …then create GitHub release v<version>
  tools/release.sh --apk-only                   # just the .apk (e.g. re-test a signing change)
  tools/release.sh --deb-only
  tools/release.sh --keystore ~/.android/gitview-release.jks     # sign with a specific key file
  tools/release.sh --keystore-props /secure/ks.properties        # use an alternate signing config
  tools/release.sh --publish --clobber          # overwrite an existing release's assets
  tools/release.sh --publish --notes NOTES.md --tag v0.1.5 --draft

OPTIONS
  Build
    --deb-only             Build only the bridge .deb.
    --apk-only             Build only the Android .apk.
    --out DIR              Output directory (default: dist/, wiped each run).
    --skip-version-check   Don't require bridge and app versions to match (they should, per lockstep).

  Signing
    --keystore PATH        Sign the .apk with this keystore (.jks) file. The store/key passwords and
                           alias still come from android/keystore.properties (never passed on argv).
    --keystore-props PATH  Use an alternate, self-contained keystore.properties (its own storeFile +
                           storePassword + keyAlias + keyPassword). Mutually exclusive with --keystore.

  Publish (all imply nothing unless --publish is given)
    --publish              Create a GitHub release with the built assets (needs an authenticated gh).
    --tag TAG              Release tag (default: v<version>).
    --target REF           Branch/commit the release tags (default: main).
    --notes FILE           Release-notes markdown (default: a generated file with verify steps).
    --draft                Publish as a draft.
    --prerelease           Mark the release as a prerelease.
    --clobber              If the release/tag already exists, overwrite its assets instead of failing.
    --yes, -y              Don't prompt before publishing / on a dirty tree.

  -h, --help               Show this help.

ENVIRONMENT (overrides; flags win over these)
  OUT_DIR                   Default output directory.
  JAVA_HOME                 JDK for the Android build (default: java-17-openjdk-amd64).
  ANDROID_HOME / ANDROID_SDK_ROOT   Android SDK location (for build-tools / apksigner).
  APKSIGNER, GH            Explicit apksigner / gh binary paths.
  GITVIEW_KEYSTORE_PROPS   keystore.properties path (what --keystore/--keystore-props set internally).
  GITVIEW_RELEASE_TARGET   Default --target branch.
  GITVIEW_CERT_SHA256      If set, the built APK's cert digest MUST equal it — guards against a wrong key.

REQUIREMENTS
  node + dpkg-deb (.deb); a JDK 17 + Android SDK build-tools and a keystore.properties (.apk);
  an authenticated gh (only for --publish).
EOF
}

# --- parse args -----------------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --publish) PUBLISH=1 ;;
    --deb-only) BUILD_APK=0 ;;
    --apk-only) BUILD_DEB=0 ;;
    --out) OUT_DIR="${2:?--out needs a dir}"; shift ;;
    --keystore) KEYSTORE_FILE="${2:?--keystore needs a .jks path}"; shift ;;
    --keystore-props) KEYSTORE_PROPS_FILE="${2:?--keystore-props needs a path}"; shift ;;
    --tag) TAG="${2:?--tag needs a value}"; shift ;;
    --target) TARGET="${2:?--target needs a ref}"; shift ;;
    --notes) NOTES_FILE="${2:?--notes needs a file}"; shift ;;
    --draft) DRAFT=1 ;;
    --prerelease) PRERELEASE=1 ;;
    --clobber) CLOBBER=1 ;;
    --skip-version-check) SKIP_VERSION_CHECK=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1  (try --help)" ;;
  esac
  shift
done
[ "$BUILD_DEB" = 1 ] || [ "$BUILD_APK" = 1 ] || die "--deb-only and --apk-only are mutually exclusive"

# --- resolve + cross-check versions ---------------------------------------------------------------
# Read without depending on node being on PATH.
read_pkg_version() { sed -nE 's/.*"version": *"([^"]+)".*/\1/p' "$ROOT/bridge/package.json" | head -1; }
read_app_version() { sed -nE 's/.*versionName *= *"([^"]+)".*/\1/p' "$ROOT/android/app/build.gradle.kts" | head -1; }

BRIDGE_VERSION="$(read_pkg_version)"; [ -n "$BRIDGE_VERSION" ] || die "couldn't read bridge/package.json version"
APP_VERSION="$(read_app_version)";    [ -n "$APP_VERSION" ]    || die "couldn't read app versionName"
if [ "$BRIDGE_VERSION" != "$APP_VERSION" ] && [ "$SKIP_VERSION_CHECK" = 0 ]; then
  die "version mismatch — bridge=$BRIDGE_VERSION app=$APP_VERSION. Bump both in lockstep, or pass --skip-version-check."
fi
VERSION="$BRIDGE_VERSION"
TAG="${TAG:-v$VERSION}"

echo "GitView release  version=$VERSION  tag=$TAG  out=$OUT_DIR"
echo "  build: deb=$([ "$BUILD_DEB" = 1 ] && echo yes || echo no)  apk=$([ "$BUILD_APK" = 1 ] && echo yes || echo no)  publish=$([ "$PUBLISH" = 1 ] && echo yes || echo no)"

# --- resolve the signing config (keeps passwords off the command line) ----------------------------
# EFFECTIVE_KEYSTORE_PROPS is the keystore.properties Gradle will read (via GITVIEW_KEYSTORE_PROPS).
EFFECTIVE_KEYSTORE_PROPS="$DEFAULT_KEYSTORE_PROPS"
TMP_KS_DIR=""
cleanup() { [ -n "$TMP_KS_DIR" ] && rm -rf "$TMP_KS_DIR"; }
trap cleanup EXIT
abspath() { echo "$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; }
if [ -n "$KEYSTORE_FILE" ] && [ -n "$KEYSTORE_PROPS_FILE" ]; then
  die "--keystore and --keystore-props are mutually exclusive."
elif [ -n "$KEYSTORE_PROPS_FILE" ]; then
  [ -f "$KEYSTORE_PROPS_FILE" ] || die "--keystore-props: no such file: $KEYSTORE_PROPS_FILE"
  EFFECTIVE_KEYSTORE_PROPS="$(abspath "$KEYSTORE_PROPS_FILE")"
  echo "  signing: keystore.properties = $EFFECTIVE_KEYSTORE_PROPS"
elif [ -n "$KEYSTORE_FILE" ]; then
  [ -f "$KEYSTORE_FILE" ] || die "--keystore: no such file: $KEYSTORE_FILE"
  [ -f "$DEFAULT_KEYSTORE_PROPS" ] || die "--keystore needs android/keystore.properties for the passwords + alias — create it, or use --keystore-props for a fully self-contained config."
  # Synthesize a keystore.properties = the given .jks + the passwords/alias from the default file,
  # written 0600 to a temp dir (removed on exit). The secrets never appear as arguments.
  getprop() { sed -nE "s/^$1=(.*)$/\1/p" "$DEFAULT_KEYSTORE_PROPS" | head -1; }
  TMP_KS_DIR="$(mktemp -d)"; EFFECTIVE_KEYSTORE_PROPS="$TMP_KS_DIR/keystore.properties"
  ( umask 077
    printf 'storeFile=%s\n'      "$(abspath "$KEYSTORE_FILE")" >  "$EFFECTIVE_KEYSTORE_PROPS"
    printf 'storePassword=%s\n'  "$(getprop storePassword)"    >> "$EFFECTIVE_KEYSTORE_PROPS"
    printf 'keyAlias=%s\n'       "$(getprop keyAlias)"         >> "$EFFECTIVE_KEYSTORE_PROPS"
    printf 'keyPassword=%s\n'    "$(getprop keyPassword)"      >> "$EFFECTIVE_KEYSTORE_PROPS" )
  echo "  signing: keystore = $(abspath "$KEYSTORE_FILE")  (passwords/alias from android/keystore.properties)"
fi

# --- preflight ------------------------------------------------------------------------------------
if [ "$BUILD_DEB" = 1 ]; then
  command -v node >/dev/null 2>&1 || die "node not found (needed to compile the bridge). Put it on PATH."
  command -v dpkg-deb >/dev/null 2>&1 || die "dpkg-deb not found (needed to build the .deb)."
fi
APKSIGNER=""
if [ "$BUILD_APK" = 1 ]; then
  [ -x "$JAVA_HOME/bin/java" ] || die "no JDK at JAVA_HOME=$JAVA_HOME (override JAVA_HOME=…)."
  [ -f "$EFFECTIVE_KEYSTORE_PROPS" ] || die "no signing config at $EFFECTIVE_KEYSTORE_PROPS — the .apk would be UNSIGNED. Create android/keystore.properties, or pass --keystore / --keystore-props."
  APKSIGNER="${APKSIGNER:-$(ls "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1)}"
  [ -n "$APKSIGNER" ] && [ -x "$APKSIGNER" ] || die "apksigner not found under $ANDROID_HOME/build-tools/* (set ANDROID_HOME or APKSIGNER)."
fi
if [ "$PUBLISH" = 1 ]; then
  command -v "$GH_BIN" >/dev/null 2>&1 || die "gh not found (needed for --publish). Install it or unset --publish."
  "$GH_BIN" auth status >/dev/null 2>&1 || die "gh is not authenticated — run 'gh auth login' first."
fi

rm -rf "$OUT_DIR"; mkdir -p "$OUT_DIR"
export JAVA_HOME ANDROID_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"

DEB_ASSET=""; APK_ASSET=""

# --- build the bridge .deb ------------------------------------------------------------------------
if [ "$BUILD_DEB" = 1 ]; then
  step "Building bridge .deb (version $VERSION)"
  bash "$ROOT/bridge/packaging/deb/build.sh" "$OUT_DIR"
  DEB_ASSET="$(ls "$OUT_DIR"/gitview-bridge_"${VERSION}"_*.deb 2>/dev/null | head -1)"
  [ -n "$DEB_ASSET" ] || die "the .deb build did not produce gitview-bridge_${VERSION}_*.deb"
  echo "   → $(basename "$DEB_ASSET")  ($(du -h "$DEB_ASSET" | cut -f1))"
fi

# --- build + verify the Android .apk --------------------------------------------------------------
if [ "$BUILD_APK" = 1 ]; then
  step "Assembling release .apk (version $VERSION)"
  ( cd "$ROOT/android" && GITVIEW_KEYSTORE_PROPS="$EFFECTIVE_KEYSTORE_PROPS" ./gradlew :app:assembleRelease -q )
  built="$ROOT/android/app/build/outputs/apk/release/app-release.apk"
  [ -f "$built" ] || die "assembleRelease did not produce $built"
  APK_ASSET="$OUT_DIR/gitview-$VERSION.apk"
  cp "$built" "$APK_ASSET"

  step "Verifying APK signature"
  "$APKSIGNER" verify "$APK_ASSET" >/dev/null 2>&1 || die "the built APK is NOT validly signed — check android/keystore.properties."
  DIGEST="$("$APKSIGNER" verify --print-certs "$APK_ASSET" 2>/dev/null | sed -nE 's/.*SHA-256 digest: *([0-9a-f]+).*/\1/p' | head -1)"
  DN="$("$APKSIGNER" verify --print-certs "$APK_ASSET" 2>/dev/null | sed -nE 's/.*certificate DN: *(.*)/\1/p' | head -1)"
  echo "   signer:      $DN"
  echo "   cert SHA-256: $DIGEST"
  if [ -n "${GITVIEW_CERT_SHA256:-}" ] && [ "${GITVIEW_CERT_SHA256,,}" != "${DIGEST,,}" ]; then
    die "APK cert digest $DIGEST != expected GITVIEW_CERT_SHA256 — wrong signing key."
  fi
  echo "   → $(basename "$APK_ASSET")  ($(du -h "$APK_ASSET" | cut -f1))"
fi

# --- checksums ------------------------------------------------------------------------------------
step "Writing SHA256SUMS"
( cd "$OUT_DIR" && sha256sum $( [ -n "$APK_ASSET" ] && basename "$APK_ASSET" ) $( [ -n "$DEB_ASSET" ] && basename "$DEB_ASSET" ) > SHA256SUMS )
cat "$OUT_DIR/SHA256SUMS"

echo; echo "Built into $OUT_DIR:"; ls -1 "$OUT_DIR"

# --- publish (optional) ---------------------------------------------------------------------------
if [ "$PUBLISH" = 0 ]; then
  echo; echo "Done (not published). To publish:  tools/release.sh --publish --tag $TAG"
  exit 0
fi

# Warn on a dirty working tree — a published binary should usually match a commit.
if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ] && [ "$ASSUME_YES" = 0 ]; then
  echo; echo "WARNING: the working tree is dirty — you'd be publishing binaries that don't match any commit."
  read -r -p "Publish $TAG anyway? [y/N] " ans; [ "$ans" = y ] || [ "$ans" = Y ] || die "aborted."
fi

# Assemble the asset list actually built.
ASSETS=(); [ -n "$DEB_ASSET" ] && ASSETS+=("$DEB_ASSET"); [ -n "$APK_ASSET" ] && ASSETS+=("$APK_ASSET"); ASSETS+=("$OUT_DIR/SHA256SUMS")

# Notes: caller-supplied, or a generated default with verify instructions.
GEN_NOTES=""
if [ -z "$NOTES_FILE" ]; then
  GEN_NOTES="$OUT_DIR/RELEASE_NOTES.md"
  {
    echo "## GitView $TAG"
    echo
    echo "Prebuilt artifacts: the Android app (\`gitview-$VERSION.apk\`) and the host bridge"
    echo "(\`$( [ -n "$DEB_ASSET" ] && basename "$DEB_ASSET" || echo gitview-bridge_${VERSION}_all.deb )\`), plus \`SHA256SUMS\`."
    echo
    echo '### Verify'
    echo '```'
    echo 'sha256sum -c SHA256SUMS'
    echo "apksigner verify --print-certs gitview-$VERSION.apk   # cert SHA-256 must match the README"
    echo '```'
  } > "$GEN_NOTES"
  NOTES_FILE="$GEN_NOTES"
fi

GH_FLAGS=(--target "$TARGET" --title "GitView $TAG" --notes-file "$NOTES_FILE")
[ "$DRAFT" = 1 ] && GH_FLAGS+=(--draft)
[ "$PRERELEASE" = 1 ] && GH_FLAGS+=(--prerelease)

if "$GH_BIN" release view "$TAG" >/dev/null 2>&1; then
  [ "$CLOBBER" = 1 ] || die "release $TAG already exists. Re-run with --clobber to overwrite its assets."
  step "Uploading assets to existing release $TAG (--clobber)"
  "$GH_BIN" release upload "$TAG" "${ASSETS[@]}" --clobber
else
  step "Creating GitHub release $TAG"
  "$GH_BIN" release create "$TAG" "${ASSETS[@]}" "${GH_FLAGS[@]}"
fi

echo; echo "Published $TAG:"; "$GH_BIN" release view "$TAG" --json url,assets -q '.url, (.assets[] | "  " + .name)'
