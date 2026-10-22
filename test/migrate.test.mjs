import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHome } from "../src/store.mjs";

process.env.AUTOSWITCH_TEST_KEY = "ef".repeat(32);

test(
  "首次运行把旧 CreditPilot 数据迁移到 AutoSwitch，且不复制 pid/旧启动器",
  { skip: process.platform !== "win32" },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoswitch-migrate-"));
    const previousLocalAppData = process.env.LOCALAPPDATA;
    const previousHome = process.env.AUTOSWITCH_HOME;
    const previousLegacyHome = process.env.CREDITPILOT_HOME;
    try {
      delete process.env.AUTOSWITCH_HOME;
      delete process.env.CREDITPILOT_HOME;
      process.env.LOCALAPPDATA = root;
      const legacy = path.join(root, "CreditPilot");
      const next = path.join(root, "AutoSwitch");
      fs.mkdirSync(legacy, { recursive: true });
      fs.writeFileSync(path.join(legacy, "config.json"), '{"port":47871}');
      fs.writeFileSync(path.join(legacy, "accounts.enc"), "encrypted-account-store");
      fs.writeFileSync(path.join(legacy, "store.key"), "protected-key");
      fs.writeFileSync(path.join(legacy, "server.pid"), "12345");
      fs.writeFileSync(path.join(legacy, "start-creditpilot.vbs"), "old launcher");

      assert.equal(resolveHome(), next);
      assert.equal(fs.readFileSync(path.join(next, "config.json"), "utf8"), '{"port":47871}');
      assert.equal(fs.readFileSync(path.join(next, "accounts.enc"), "utf8"), "encrypted-account-store");
      assert.equal(fs.readFileSync(path.join(next, "store.key"), "utf8"), "protected-key");
      assert.equal(fs.existsSync(path.join(next, "server.pid")), false);
      assert.equal(fs.existsSync(path.join(next, "start-creditpilot.vbs")), false);
      assert.equal(fs.existsSync(path.join(legacy, "config.json")), true);
    } finally {
      if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previousLocalAppData;
      if (previousHome === undefined) delete process.env.AUTOSWITCH_HOME;
      else process.env.AUTOSWITCH_HOME = previousHome;
      if (previousLegacyHome === undefined) delete process.env.CREDITPILOT_HOME;
      else process.env.CREDITPILOT_HOME = previousLegacyHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
