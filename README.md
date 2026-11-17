<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0b2537,50:0e7490,100:22d3ee&height=200&section=header&text=OURDROP&fontSize=72&fontColor=ffffff&animation=fadeIn&fontAlignY=36&desc=Share%20Freely%20%C2%B7%20Connect%20Seamlessly&descSize=19&descAlignY=58" width="100%"/>

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=600&size=21&duration=2800&pause=900&color=22D3EE&center=true&vCenter=true&width=700&lines=PC+%E2%87%84+Mobile+%E2%80%94+over+your+own+Wi-Fi;No+internet+%C2%B7+No+login+%C2%B7+No+cables;Drag+%26+drop+%E2%80%94+in+both+directions;Pause+%26+resume+%E2%80%94+with+SHA-256+verify" alt="Typing SVG" />

<br/>

![Android](https://img.shields.io/badge/Android-7.0%2B-3DDC84?style=for-the-badge&logo=android&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D6?style=for-the-badge&logo=windows&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-.deb-FCC624?style=for-the-badge&logo=linux&logoColor=black)
![Version](https://img.shields.io/badge/Version-v60-0e7490?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)

<br/>

<a href="https://github.com/Ali-Emam-Rabbi/OurDrop-Software-Project/releases/download/v60/OurDrop-Setup-v60.exe"><img src="https://img.shields.io/badge/%E2%AC%87%EF%B8%8F_DOWNLOAD_FOR_WINDOWS-Setup_v60-0e7490?style=for-the-badge" alt="Download OurDrop Setup for Windows"/></a>
<a href="https://github.com/Ali-Emam-Rabbi/OurDrop-Software-Project/releases/download/v60/OurDrop-v60.apk"><img src="https://img.shields.io/badge/%E2%AC%87%EF%B8%8F_DOWNLOAD_THE_ANDROID_APP-v60-3DDC84?style=for-the-badge" alt="Download OurDrop for Android"/></a>
<a href="https://github.com/Ali-Emam-Rabbi/OurDrop-Software-Project/releases/download/v60/OurDrop-v60-linux.deb"><img src="https://img.shields.io/badge/%E2%AC%87%EF%B8%8F_DOWNLOAD_FOR_LINUX-.deb_v60-FCC624?style=for-the-badge" alt="Download OurDrop for Linux"/></a>

**Send files of any type between your PC and your Android phone over your own Wi-Fi — no internet, no login, no cables, no cloud.**

</div>

---

## ✦ What is OurDrop?

OurDrop is a small, fast file-transfer app built by two CSE students. Put your PC and phone on the same Wi-Fi, scan a QR code once, and then just drag & drop — photos, videos, PDFs, ZIPs, APKs, anything — in **both directions**, with live progress, speed and size. The phone can keep receiving in the background with the app closed, and both apps update themselves from inside the app.

No accounts. No uploads to anyone's server. Your files never leave your own network.

## ⚡ Features

<table width="100%">
<tr>
<td width="50%">

📷 **QR-code connect**
Scan the code on the PC screen and you are connected — no typing IP addresses

</td>
<td width="50%">

🖱️ **Drag & drop sending**
Drop files on the app, or pick them — many files at once, any type, any size

</td>
</tr>
<tr>
<td width="50%">

🔁 **Both-direction transfer**
PC → phone and phone → PC, from the same simple screen

</td>
<td width="50%">

⏸️ **Chunked uploads — pause & resume**
Big files move in 4 MB chunks; pause, resume, or survive a dropped connection

</td>
</tr>
<tr>
<td width="50%">

🔐 **SHA-256 verification**
Every finished upload is hash-checked, so a "completed" file is a correct file

</td>
<td width="50%">

📥 **Background auto-receive**
The Android foreground service receives while the app is closed or the screen is off

</td>
</tr>
<tr>
<td width="50%">

📶 **Phone-hotspot support**
No router? The PC can join the phone's hotspot and everything still works

</td>
<td width="50%">

🔍 **mDNS auto-discovery**
The phone finds the PC on the network by itself (`_ourdrop._tcp`)

</td>
</tr>
<tr>
<td width="50%">

🔄 **In-app updates**
Phone and PC both download and install new versions from inside the app

</td>
<td width="50%">

🖥️ **Lives in the tray**
Starts with Windows into the system tray — ready before you ask, quiet until you click

</td>
</tr>
<tr>
<td colspan="2">

🚫 **No login, no account, no internet** — everything runs on your local Wi-Fi, fully offline

</td>
</tr>
</table>

## 🧠 How it works

```
Phone and PC on the same Wi-Fi  (or the PC joins the phone's hotspot)
        |
Open OurDrop on the PC — a local server starts and shows a QR code
        |
Scan it with the phone  (or pick the PC the phone found automatically)
        |
Drag & drop files on either side — live progress, speed and size
        |
Files land in Downloads on the phone / the shared folder on the PC  ✓
```

Under the hood: the PC runs a small dependency-free Node.js server (HTTP + a hand-rolled WebSocket for live progress). The phone is a native Android app whose WebView shows the same React UI the PC uses — bundled inside the APK, so it opens straight to the dashboard even before connecting.

## ⬇️ Download — v60 (final)

| Platform | File | Notes |
|---|---|---|
| 🪟 **Windows 10/11** | [**OurDrop-Setup-v60.exe**](https://github.com/Ali-Emam-Rabbi/OurDrop-Software-Project/releases/download/v60/OurDrop-Setup-v60.exe) | Installer — Start Menu + Desktop shortcuts, starts in the tray |
| 🤖 **Android 7.0+** | [**OurDrop-v60.apk**](https://github.com/Ali-Emam-Rabbi/OurDrop-Software-Project/releases/download/v60/OurDrop-v60.apk) | Sideload — Android asks once to allow the install |
| 🐧 **Linux (Debian/Ubuntu)** | [**OurDrop-v60-linux.deb**](https://github.com/Ali-Emam-Rabbi/OurDrop-Software-Project/releases/download/v60/OurDrop-v60-linux.deb) | `sudo dpkg -i OurDrop-v60-linux.deb` |
| 🗜️ **Windows (portable)** | [**OurDrop-PC-v60.zip**](https://drive.google.com/file/d/1iLi0OcjuSUruvTOPLIpiJbbDKf8yjV6L/view) | Unzip and run — no installation |

## 📦 Versions

| Version | Status | Details |
|---|---|---|
| 📱 **Android** | ✅ **Final — v60** (60.0) | Native app + bundled web UI. Full source in [`ourdrop/android/`](ourdrop/android/) |
| 🖥️ **PC** | ✅ **Final — v60.0.0** | Electron app, NSIS Setup + Linux .deb. Full source in [`ourdrop-app/`](ourdrop-app/) |

OurDrop grew from a small Python prototype (v1) through a full React + Electron + native-Android rewrite (v9) to this final v60 — every version shaped by real on-device testing.

## 🗂 What's inside

```
OurDrop-Software-Project/
├── ourdrop-app/            · PC app + the shared web UI
│   ├── src/                · React + TypeScript UI (used by PC and phone alike)
│   ├── server/             · dependency-free Node.js file server + WebSocket
│   ├── electron/           · Electron shell — tray, autostart, in-app updates
│   ├── installer/          · NSIS installer script (Windows Setup)
│   ├── public/             · UI assets — photos, fonts, icons (binary, see note)
│   └── build/              · app icon (binary, see note)
├── ourdrop/
│   └── android/            · Android app — native Java
│       ├── src-project/    · Gradle project (wrapper included)
│       ├── libs/           · ZXing core jar (binary, see note)
│       ├── build-manual.sh · the aapt2 → javac → d8 → apksigner release pipeline
│       └── README.md       · Android build guide
├── tools/
│   └── exe-edit/           · stamps the OurDrop icon + version info into the Windows exe
├── LICENSE                 · MIT
└── README.md               · you are here
```

> **A note on binary assets:** this Git repository holds the text source. Binary assets — the developer photos, the General Sans fonts, the app icons, the Android launcher/resource images and fonts, and the ZXing jar — travel with the **full source archive (`OurDrop-v60-Full-Source.zip`)** shared alongside the downloads above, because they cannot be stored in this repository. Everything else regenerates from what is here: `npm run build` rebuilds `dist/`, and `build-manual.sh` re-bundles the web UI into the APK.

## 🛠 Tech stack

| Layer | Tech |
|---|---|
| Web UI | React 19 + TypeScript + Vite |
| PC shell | Electron 45 |
| File server | Node.js — zero dependencies, hand-rolled WebSocket |
| Android | Java (framework APIs only, no AndroidX) · ZXing for QR scanning |
| Installer | NSIS (Windows) · dpkg .deb (Linux) |
| Discovery | mDNS (`_ourdrop._tcp`) + Android NSD |

## 🔨 Building

**PC app / web UI**

```sh
cd ourdrop-app
npm install
npm run build    # type-check + build the UI into dist/
npm run app      # build + launch the Electron app
```

**Android** — see [`ourdrop/android/README.md`](ourdrop/android/README.md). In short: build the web UI first, then run `build-manual.sh` with a JDK 17 and the Android SDK on `JAVA_HOME` / `ANDROID_HOME`. The release keystore is private and is **not** in this repository; the script explains how to use your own.

## ⚠️ Notes — stated honestly

- OurDrop is made for **your own local network**: transfers run over plain HTTP on that network (there is no encryption), so use it on a trusted home Wi-Fi.
- The Windows installer is **not code-signed yet**, so SmartScreen may say "Windows protected your PC" — choose **More info → Run anyway**.
- The Android app is distributed as an APK, not through the Play Store.
- An optional **pairing approval** for new devices exists in Settings; it is off by default.

## 👨‍💻 Developers

<table width="100%">
<tr>
<td width="50%" align="center">

<img src="https://drive.google.com/uc?export=view&id=1ndDv-gL0XQWvSudAkAuHCBXbL6bURfNh" width="130" alt="Ali Emam Rabbi"/>
<br/><br/><b>Ali Emam Rabbi</b>
<br/>B.Sc. in Computer Science &amp; Engineering
<br/>First Capital University of Bangladesh
<br/><br/><a href="https://www.facebook.com/aliemam.rabby"><img src="https://img.shields.io/badge/Facebook-1877F2?style=for-the-badge&logo=facebook&logoColor=white" height="22" alt="Facebook"/></a>&nbsp;<a href="https://www.linkedin.com/in/aliemamrabbi/"><img src="https://img.shields.io/badge/LinkedIn-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white" height="22" alt="LinkedIn"/></a>&nbsp;<a href="https://github.com/Ali-Emam-Rabbi"><img src="https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white" height="22" alt="GitHub"/></a>&nbsp;<a href="https://aliemamportfolio.netlify.app/"><img src="https://img.shields.io/badge/Portfolio-00C7B7?style=for-the-badge&logo=netlify&logoColor=white" height="22" alt="Portfolio"/></a>

</td>
<td width="50%" align="center">

<img src="https://raw.githubusercontent.com/Sadhin404/Projects/main/Zynox%20Download%20Manager/Mobile%20Version/app/src/main/res/drawable-nodpi/dev_m1.jpg" width="130" alt="Sadhin Khan"/>
<br/><br/><b>Sadhin Khan</b>
<br/>B.Sc. in Computer Science &amp; Engineering
<br/>First Capital University of Bangladesh
<br/><br/><a href="https://www.facebook.com/zboy404"><img src="https://img.shields.io/badge/Facebook-1877F2?style=for-the-badge&logo=facebook&logoColor=white" height="22" alt="Facebook"/></a>&nbsp;<a href="https://github.com/Sadhin404"><img src="https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white" height="22" alt="GitHub"/></a>&nbsp;<a href="https://www.instagram.com/sadhin.404"><img src="https://img.shields.io/badge/Instagram-E4405F?style=for-the-badge&logo=instagram&logoColor=white" height="22" alt="Instagram"/></a>

</td>
</tr>
</table>

<div align="center">

<a href="https://t.me/technest404"><img src="https://img.shields.io/badge/Join_us_on_Telegram-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram"/></a>

<br/><br/>

*Share Freely. Connect Seamlessly.*

© 2026 OurDrop · Crafted with ❤ by Ali Emam Rabbi &amp; Sadhin Khan · [MIT License](LICENSE)

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0b2537,50:0e7490,100:22d3ee&height=110&section=footer" width="100%"/>

</div>
