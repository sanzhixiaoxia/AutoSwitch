import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveDevice, tcDecrypt, uidFromJwt, __testing } from "../src/providers/trae.mjs";

function sealTc(value, random = crypto.randomBytes(32)) {
  const { WOE, VOE, JOE, HOE, HEADER, sha512, pepper } = __testing;
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const plain = Buffer.concat([sha512(body), body]);
  const key = sha512(Buffer.concat([sha512(random), pepper(WOE, VOE)]));
  const cipher = crypto.createCipheriv("aes-128-cbc", key.subarray(0, 16), key.subarray(16, 32));
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([HEADER, random, encrypted]).toString("base64");
}

test("Trae tc 信封可解密并校验完整性", () => {
  const payload = { token: "Cloud-IDE-JWT test", userId: "42", account: { username: "测试账号" } };
  assert.deepEqual(tcDecrypt(sealTc(payload)), payload);
  assert.equal(tcDecrypt("not-a-tc-payload"), null);
  assert.equal(tcDecrypt(""), null);
});

test("Trae 设备号按 uid 稳定派生且为纯数字", () => {
  const a = deriveDevice("1234567890123456", 0);
  const b = deriveDevice("1234567890123456", 0);
  assert.deepEqual(a, b);
  assert.match(a.deviceId, /^[1-9]\d{15}$/);
  assert.equal(a.deviceId.length, 16);
  assert.match(a.marketUserId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(a.sessionId, /^[0-9a-f]{64}$/);
  assert.notEqual(deriveDevice("1234567890123456", 1).deviceId, a.deviceId);
  assert.notEqual(deriveDevice("111", 0).deviceId, a.deviceId);
});

test("Trae JWT 用户 ID 解析", () => {
  const header = Buffer.from("{}").toString("base64url");
  const payload = Buffer.from(JSON.stringify({ data: { id: 12345 } })).toString("base64url");
  assert.equal(uidFromJwt(`${header}.${payload}.sig`), "12345");
  assert.equal(uidFromJwt("bad"), null);
});

test("Trae 登录快照保存与恢复，缓存目录不进入快照", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoswitch-trae-slot-"));
  try {
    const home = path.join(root, "home");
    const dataA = path.join(root, "dataA");
    const dataB = path.join(root, "dataB");
    for (const [dir, value] of [
      [dataA, "A"],
      [dataB, "B"],
    ]) {
      fs.mkdirSync(path.join(dir, "User", "globalStorage"), { recursive: true });
      fs.mkdirSync(path.join(dir, "Cache"), { recursive: true });
      fs.writeFileSync(path.join(dir, "User", "globalStorage", "storage.json"), `{"value":"${value}"}`);
      fs.writeFileSync(path.join(dir, "machineid"), value);
      fs.writeFileSync(path.join(dir, "Cache", "cache.bin"), value);
    }
    const saved = __testing.saveSlot(home, { dataDir: dataA }, "user-1");
    assert.ok(saved.count >= 2);
    assert.deepEqual(saved.failures, []);
    const slot = path.join(home, "trae-slots", "user-1");
    assert.equal(fs.readFileSync(path.join(slot, "User", "globalStorage", "storage.json"), "utf8"), '{"value":"A"}');
    assert.equal(fs.existsSync(path.join(slot, "Cache")), false);

    const restored = __testing.restoreSlot(home, { dataDir: dataB }, "user-1");
    assert.ok(restored.count >= 2);
    assert.equal(fs.readFileSync(path.join(dataB, "User", "globalStorage", "storage.json"), "utf8"), '{"value":"A"}');
    assert.equal(fs.readFileSync(path.join(dataB, "machineid"), "utf8"), "A");
    assert.equal(fs.readFileSync(path.join(dataB, "Cache", "cache.bin"), "utf8"), "B");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
