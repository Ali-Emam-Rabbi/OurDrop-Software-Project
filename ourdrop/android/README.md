# OurDrop — Android App

Native Android app for OurDrop (PC ⇄ Mobile file transfer over local Wi-Fi).

Package: `com.ourdrop.app` · minSdk 24 (Android 7.0) · targetSdk 34 · **version 60 (60.0)**

## What the app does

- **Opens straight to the dashboard** — the web UI is bundled inside the APK
  (`assets/web`, served under a local offline origin), so the app works even
  before a PC is connected. The same UI is served live by the PC when connected.
- **Connect** — finds the PC automatically on the local network (NSD / mDNS
  `_ourdrop._tcp`), or scan the QR code the PC app shows (ZXing, camera
  permission at runtime). Phone-hotspot connections are supported.
- **Background auto-receive** — a foreground service (`ReceiveService`) polls
  the PC and downloads offered files into the public **Downloads** folder,
  with progress reported back to the PC. It keeps working with the app
  closed or the screen off, and goes dormant when no local network exists.
- **In-app updates** — the app checks a small `version.json`, downloads the
  new APK itself and verifies it (size, ZIP magic, package name) before
  offering the install.
- Native viewers for images, video and PDF; a native About screen; manual
  downloads are handled natively (`DownloadManager` → Downloads folder).

## Project layout

- `src-project/` — standard Gradle project (Gradle 8.7 wrapper, AGP 8.5.2,
  single dependency `com.google.zxing:core:3.5.3`, framework APIs only —
  no AndroidX). On a normal network: `cd src-project && ./gradlew assembleDebug`.
- `build-manual.sh` — the pipeline actually used to produce the release APK
  (see below). It also bundles the web UI: it copies `../../ourdrop-app/dist`
  into `src-project/app/src/main/assets/web`, so build the web app first:
  `(cd ../../ourdrop-app && npm install && npm run build)`.
- `libs/zxing-core-3.5.3.jar` — ZXing, fetched for the manual build
  (binary — distributed with the full source archive, or fetch
  `com.google.zxing:core:3.5.3` from Maven Central).

## Why the manual pipeline?

The machine that built the releases has an egress proxy that resets TLS
connections made from Java (Gradle dependency downloads fail, while curl
works fine). So the toolchain was laid out by hand (Temurin JDK 17 +
Android SDK platform/build-tools) and the APK is built with the classic
pipeline:

```
aapt2 compile + link  →  javac (android.jar on classpath)  →  d8 (min-api 24)
→  zipalign  →  apksigner (release key)
```

Rebuild: `bash build-manual.sh` — set `JAVA_HOME` / `ANDROID_HOME` to your
own JDK 17 and Android SDK (platform android-34, build-tools 34.0.0), or
override with `OURDROP_DIST` / `OURDROP_SIGN_DIR`.

Note: `javac` must NOT use `-bootclasspath android.jar` — that breaks
lambda compilation (`LambdaMetafactory`); android.jar on the regular
classpath plus D8 desugaring is the working combination.

## Signing

Release APKs are signed with the OurDrop release key. **That keystore is
private and is not part of this repository** — `build-manual.sh` step 6
looks for it in `$OURDROP_SIGN_DIR` (default `~/ourdrop-signing`) and
refuses to sign if it is missing. For your own builds, create your own
keystore there (`ourdrop-release.jks` + `keystore-password.txt`), or sign
the aligned APK with your own key afterwards.
