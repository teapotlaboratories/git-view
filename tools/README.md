# tools/

Developer scripts for GitView.

## `release.sh` — build (and optionally publish) a release

Builds both shippable artifacts from the current tree, in lockstep:

- **`gitview-bridge_<version>_all.deb`** — the host bridge (via `bridge/packaging/deb/build.sh`).
- **`gitview-<version>.apk`** — the Android app, **release-signed** (via `./gradlew :app:assembleRelease`,
  which reads `android/keystore.properties`).

It then verifies the APK's signature (printing the certificate's SHA-256, which must match the
fingerprint published in the root `README.md`), writes a `SHA256SUMS`, and — with `--publish` — creates
a GitHub release with all three assets. Output lands in a clean `dist/` (gitignored) by default.

```bash
tools/release.sh                       # build both → dist/, verify, checksum (no publish)
tools/release.sh --publish             # …then create GitHub release v<version>
tools/release.sh --apk-only            # just the .apk (e.g. re-test a signing change)
tools/release.sh --deb-only
tools/release.sh --publish --clobber   # overwrite an existing release's assets
tools/release.sh --help                # all flags + environment overrides
```

### Choosing the signing key

By default the `.apk` is signed from `android/keystore.properties`. To sign with a key elsewhere:

```bash
tools/release.sh --keystore ~/.android/gitview-release.jks   # a specific .jks; passwords/alias
                                                             #   still from android/keystore.properties
tools/release.sh --keystore-props /secure/ks.properties      # a self-contained alternate config
                                                             #   (its own storeFile + passwords + alias)
```

Passwords are **never** passed on the command line: the Gradle build reads a `keystore.properties`
whose path is handed over via the `GITVIEW_KEYSTORE_PROPS` env var (`app/build.gradle.kts` honours the
`keystorePropsFile` Gradle property / that env, else the default file). `--keystore` synthesizes a
temporary `0600` properties file (the given `.jks` + the passwords/alias from the default file) and
deletes it on exit.

**Version** comes from `bridge/package.json`; the script refuses to run if the app's `versionName`
doesn't match (bump both together — pass `--skip-version-check` only if you mean it).

**Requirements:** `node` + `dpkg-deb` for the `.deb`; a JDK 17 + Android SDK build-tools and a present
`android/keystore.properties` for the signed `.apk`; an authenticated `gh` only for `--publish`.
Tool locations auto-detect but are overridable (`JAVA_HOME`, `ANDROID_HOME`, `APKSIGNER`, `GH`, …).

**Signing note:** the `.apk` is signed with your release key so it installs over prior GitView releases.
Set `GITVIEW_CERT_SHA256=<digest>` to make the script hard-fail if the built APK is signed with any
other key — a guard against accidentally shipping a wrong-key build.
