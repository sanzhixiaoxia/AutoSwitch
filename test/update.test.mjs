import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, summarizeRelease } from "../src/update.mjs";

test("版本比较支持 v 前缀和多位数字", () => {
  assert.equal(compareVersions("0.2.0", "0.1.0"), 1);
  assert.equal(compareVersions("0.2.0", "v0.2.0"), 0);
  assert.equal(compareVersions("0.9.9", "0.10.0"), -1);
  assert.equal(compareVersions("v1.0.0", "0.99.99"), 1);
});

test("GitHub Release 摘要包含安装包和便携版下载", () => {
  const release = {
    tag_name: "v0.3.0",
    name: "AutoSwitch 0.3.0",
    html_url: "https://github.com/sanzhixiaoxia/AutoSwitch/releases/tag/v0.3.0",
    published_at: "2026-10-22T10:00:00Z",
    body: "新增功能",
    assets: [
      {
        name: "AutoSwitch-Setup-0.3.0.exe",
        browser_download_url: "https://github.com/sanzhixiaoxia/AutoSwitch/releases/download/v0.3.0/AutoSwitch-Setup-0.3.0.exe",
        size: 100,
      },
      {
        name: "AutoSwitch-Portable-0.3.0.zip",
        browser_download_url: "https://github.com/sanzhixiaoxia/AutoSwitch/releases/download/v0.3.0/AutoSwitch-Portable-0.3.0.zip",
        size: 200,
      },
    ],
  };
  const summary = summarizeRelease(release, "0.2.0");
  assert.equal(summary.latest, "0.3.0");
  assert.equal(summary.hasUpdate, true);
  assert.equal(summary.downloads.setup.name, "AutoSwitch-Setup-0.3.0.exe");
  assert.equal(summary.downloads.portable.size, 200);
  assert.match(summary.releaseUrl, /^https:\/\/github\.com\//);
});

test("同版本不提示更新，且拒绝非 GitHub 下载地址", () => {
  const release = {
    tag_name: "v0.2.0",
    html_url: "https://github.com/sanzhixiaoxia/AutoSwitch/releases/tag/v0.2.0",
    assets: [
      { name: "AutoSwitch-Setup-0.2.0.exe", browser_download_url: "https://evil.example/setup.exe", size: 1 },
    ],
  };
  const summary = summarizeRelease(release, "0.2.0");
  assert.equal(summary.hasUpdate, false);
  assert.equal(summary.downloads.setup, null);
});
