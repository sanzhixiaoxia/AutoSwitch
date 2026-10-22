import test from "node:test";
import assert from "node:assert/strict";
import { dayKey, maskMiddle, qoderRoundKey, redact, roundKey, traeRoundKey } from "../src/util.mjs";

test("北京时间日期与 Qoder 10:00 轮次边界", () => {
  assert.equal(dayKey(Date.UTC(2026, 9, 21, 16, 30)), "2026-10-22");
  assert.equal(qoderRoundKey(Date.UTC(2026, 9, 22, 1, 59, 59)), "2026-10-21");
  assert.equal(qoderRoundKey(Date.UTC(2026, 9, 22, 2, 0, 0)), "2026-10-22");
  assert.equal(traeRoundKey(Date.UTC(2026, 9, 21, 16, 30)), "2026-10-22");
  assert.equal(roundKey("qoder", Date.UTC(2026, 9, 22, 1, 0, 0)), "2026-10-21");
  assert.equal(roundKey("trae", Date.UTC(2026, 9, 21, 16, 0, 0)), "2026-10-22");
  assert.equal(roundKey("workbuddy", Date.UTC(2026, 9, 21, 16, 0, 0)), "2026-10-22");
});

test("敏感信息脱敏", () => {
  const text = "Bearer abcdefghijklmnop Authorization: Cloud-IDE-JWT eyJhbGciOiJIUzI1NiJ9.payload.signature dt-1234567890abcdef";
  const redacted = redact(text);
  assert.ok(!redacted.includes("abcdefghijklmnop"));
  assert.ok(!redacted.includes("dt-1234567890abcdef"));
  assert.ok(redacted.includes("[已隐藏]"));
  assert.equal(maskMiddle("13800138000", 3, 4), "138****8000");
});
