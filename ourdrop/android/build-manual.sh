#!/bin/bash
# Manual APK build for OurDrop (no Gradle/AGP network access needed).
# Pipeline: aapt2 compile/link -> javac -> d8 -> zipalign -> apksigner (debug).
set -euo pipefail

# Toolchain locations are machine-specific: set JAVA_HOME / ANDROID_HOME
# to your own JDK 17 and Android SDK (platform android-34, build-tools 34.0.0).
export JAVA_HOME="${JAVA_HOME:-$HOME/toolchain/jdk}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/toolchain/android-sdk}"
export PATH="$JAVA_HOME/bin:$PATH"

BT="$ANDROID_HOME/build-tools/34.0.0"
PLATFORM="$ANDROID_HOME/platforms/android-34/android.jar"
HERE="$(cd "$(dirname "$0")" && pwd)"
MAIN="$HERE/src-project/app/src/main"
ZXING="$HERE/libs/zxing-core-3.5.3.jar"
OUT="$HERE/build-manual"
PKG="com.ourdrop.app"

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "== 1/6 aapt2 compile resources"
"$BT/aapt2" compile --dir "$MAIN/res" -o "$OUT/compiled.zip"

echo "== 1b/6 bundle the web UI into assets (v54 offline dashboard)"
# The phone dashboard ships inside the APK so the app opens straight
# to it with no PC session; WebViewActivity serves assets/web under
# the offline origin. The connected path is unchanged (the PC still
# serves the live UI). Source maps are excluded.
# In this repository the web app lives next to ourdrop/ (../../ourdrop-app);
# build it first: (cd ../../ourdrop-app && npm install && npm run build).
DIST="${OURDROP_DIST:-$HERE/../../ourdrop-app/dist}"
WEBASSETS="$MAIN/assets/web"
rm -rf "$WEBASSETS"
mkdir -p "$WEBASSETS"
cp -r "$DIST/." "$WEBASSETS/"
find "$WEBASSETS" -name "*.map" -delete

echo "== 2/6 aapt2 link (inject package name for the standalone build)"
sed "s|<manifest |<manifest package=\"$PKG\" |" \
    "$MAIN/AndroidManifest.xml" > "$OUT/AndroidManifest.xml"
"$BT/aapt2" link -o "$OUT/app-unsigned.apk" \
    -I "$PLATFORM" \
    -A "$MAIN/assets" \
    --manifest "$OUT/AndroidManifest.xml" \
    --java "$OUT/gen" \
    --min-sdk-version 24 \
    --target-sdk-version 34 \
    --version-code 1 \
    --version-name "1.0" \
    "$OUT/compiled.zip"

echo "== 3/6 javac"
find "$MAIN/java" "$OUT/gen" -name "*.java" > "$OUT/sources.txt"
# NOTE: no -bootclasspath — android.jar on the regular classpath lets javac
# resolve java.lang.invoke.LambdaMetafactory from the JDK; D8 desugars the
# lambdas for minSdk 24 at the dex step.
javac -encoding UTF-8 -source 8 -target 8 \
    -cp "$PLATFORM:$ZXING" \
    -d "$OUT/classes" @"$OUT/sources.txt"

echo "== 4/6 d8 (dex)"
(cd "$OUT/classes" && "$JAVA_HOME/bin/jar" cf "$OUT/classes.jar" .)
"$BT/d8" --lib "$PLATFORM" --min-api 24 \
    --output "$OUT/dex" "$OUT/classes.jar" "$ZXING"

echo "== 5/6 add dex, zipalign"
cp "$OUT/app-unsigned.apk" "$OUT/app-tosign.apk"
(cd "$OUT/dex" && zip -q "$OUT/app-tosign.apk" classes.dex)
"$BT/zipalign" -f -p 4 "$OUT/app-tosign.apk" "$OUT/app-aligned.apk"

echo "== 6/6 sign (RELEASE key)"
# The release keystore is PRIVATE and is not part of this repository.
# Point OURDROP_SIGN_DIR at a folder holding your own keystore
# (ourdrop-release.jks + keystore-password.txt) to sign release builds.
SIGN_DIR="${OURDROP_SIGN_DIR:-$HOME/ourdrop-signing}"
KS="$SIGN_DIR/ourdrop-release.jks"
PASSFILE="$SIGN_DIR/keystore-password.txt"
if [ ! -f "$KS" ] || [ ! -f "$PASSFILE" ]; then
    echo "ERROR: release keystore or password file missing in $SIGN_DIR - refusing to sign." >&2
    exit 1
fi
ODPASS="$(tr -d '\n' < "$PASSFILE")"; export ODPASS
"$BT/apksigner" sign --ks "$KS" --ks-key-alias ourdrop \
    --ks-pass env:ODPASS --key-pass env:ODPASS \
    --out "$HERE/OurDrop.apk" "$OUT/app-aligned.apk"

echo "DONE: $HERE/OurDrop.apk"
