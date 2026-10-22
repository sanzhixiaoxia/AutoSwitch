import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCampaigns, pollDeviceLogin, startDeviceLogin } from "../src/providers/qoder.mjs";

test("Qoder 活动列表只统计生效中的领取活动", () => {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    campaigns: [
      { campaignId: "a", campaignKey: "act-a", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMABLE", startAt: now - 60, endAt: now + 60, benefit: { amount: 100 } },
      { campaignId: "b", campaignKey: "act-b", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMED", startAt: now - 60, endAt: now + 60, benefit: { amount: 100 } },
      { campaignId: "c", campaignKey: "act-c", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMABLE", startAt: now - 600, endAt: now - 60 },
      { campaignId: "d", campaignKey: "act-d", actionType: "VIEW_DETAILS", claimStatus: "CLAIMABLE", startAt: now - 60, endAt: now + 60 },
    ],
  };
  const picked = normalizeCampaigns(payload);
  assert.equal(picked.claimable.length, 1);
  assert.equal(picked.claimed.length, 1);
  assert.equal(picked.benefits.length, 2);
  assert.equal(picked.claimable[0].campaignKey, "act-a");
});

test("Qoder 设备码登录链接包含 PKCE 参数", () => {
  const session = startDeviceLogin("qoder-cn");
  const url = new URL(session.url);
  assert.equal(url.origin, "https://qoder.cn");
  assert.equal(url.pathname, "/device/selectAccounts");
  assert.equal(url.searchParams.get("challenge_method"), "S256");
  assert.ok(url.searchParams.get("challenge"));
  assert.ok(url.searchParams.get("nonce"));
  assert.ok(url.searchParams.get("machine_id"));
  assert.equal(session.expiresIn, 300);
});

test("未知登录会话返回过期", async () => {
  const result = await pollDeviceLogin({}, "missing-session");
  assert.equal(result.status, "expired");
});
