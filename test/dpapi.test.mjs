import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { dpapiProtect, electronSafeStorage, hasDpapi } from "../src/win/dpapi.mjs";

test(
  "Electron safeStorage 编解码与 Qoder 写入格式一致",
  { skip: !hasDpapi() },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoswitch-dpapi-"));
    try {
      const key = crypto.randomBytes(32);
      const protectedKey = dpapiProtect(key);
      const encryptedKey = Buffer.concat([Buffer.from("DPAPI"), protectedKey]).toString("base64");
      fs.writeFileSync(
        path.join(dir, "Local State"),
        JSON.stringify({ os_crypt: { encrypted_key: encryptedKey } }),
      );
      const codec = electronSafeStorage(dir);
      const auth = JSON.stringify({ token: "dt-test-token", user: { id: "u1", name: "测试" } });
      const encrypted = codec.encrypt(auth);
      assert.equal(encrypted.subarray(0, 3).toString(), "v10");
      assert.equal(codec.decrypt(encrypted), auth);
      assert.throws(() => codec.decrypt(Buffer.from("bad")), /格式|过短/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
