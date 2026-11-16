// Build OurDrop.exe from the stock Electron binary: embed the official
// OurDrop icon and OurDrop version identity (this is what Windows
// Search / Explorer / shortcuts read — the stock binary says "Electron").
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { NtExecutable, NtExecutableResource, Resource, Data } = require("resedit");

const [srcExe, icoPath, outExe] = process.argv.slice(2);
if (!srcExe || !icoPath || !outExe) {
  console.error("usage: make-ourdrop-exe.mjs <electron.exe> <icon.ico> <out.exe>");
  process.exit(1);
}

const exe = NtExecutable.from(fs.readFileSync(srcExe));
const res = NtExecutableResource.from(exe);
const entries = res.entries;

// ---- icon: replace every existing icon group with the OurDrop icons ----
const iconFile = Data.IconFile.from(fs.readFileSync(icoPath));
const groups = Resource.IconGroupEntry.fromEntries(entries);
if (!groups.length) throw new Error("no icon group in source exe");
for (const g of groups) {
  Resource.IconGroupEntry.replaceIconsForResource(entries, g.id, g.lang, iconFile.icons.map((i) => i.data));
}

// ---- version info: rebrand Electron -> OurDrop ----
const versions = Resource.VersionInfo.fromEntries(entries);
if (!versions.length) throw new Error("no version info in source exe");
const vi = versions[0];
const lang = vi.getAvailableLanguages()[0];
vi.setStringValues(lang, {
  ProductName: "OurDrop",
  FileDescription: "OurDrop — PC ⇄ Mobile File Sharing",
  CompanyName: "OurDrop",
  OriginalFilename: "OurDrop.exe",
  InternalName: "OurDrop",
  ProductVersion: "60.0.0",
  FileVersion: "60.0.0",
  LegalCopyright: "Copyright © 2026 Ali Emam Rabbi & Sadhin Khan",
});
try {
  vi.setFileVersion(60, 0, 0, 0, lang);
  vi.setProductVersion(60, 0, 0, 0, lang);
} catch (e) {
  console.log("fixed-info skip:", e.message);
}
vi.outputToResourceEntries(entries);

res.outputResource(exe);
fs.writeFileSync(outExe, Buffer.from(exe.generate()));
console.log("written", outExe, fs.statSync(outExe).size, "bytes");
