import { test } from "node:test";
import assert from "node:assert/strict";
import { TOKEN, connectorMay, hashToken } from "./connectors.ts";

test("a connection may read and save lists, and see its workspaces", () => {
  for (const [m, p] of [
    ["GET", "/api/lists"],
    ["POST", "/api/lists"],
    ["PUT", "/api/lists/abc123de"],
    ["DELETE", "/api/lists/abc123de"],
    ["GET", "/api/connectors/self"],
    ["GET", "/api/workspaces"],
  ])
    assert.ok(connectorMay(m, p), `${m} ${p}`);
});

test("a connection can't change the account, billing, sharing or other connections", () => {
  for (const [m, p] of [
    ["GET", "/api/keys"], // it holds no key: encrypted lists stay closed to it
    ["POST", "/api/keys/password"],
    ["POST", "/api/keys/recovery-key"],
    ["GET", "/api/connectors"],
    ["POST", "/api/connectors"],
    ["DELETE", "/api/connectors/x"],
    ["PUT", "/api/lists/order"],
    ["GET", "/api/export"],
    ["POST", "/api/billing/cancel"],
    ["POST", "/api/task-shares"],
    ["GET", "/api/lists/x/y"],
  ])
    assert.ok(!connectorMay(m, p), `${m} ${p}`);
});

test("tokens: shape checked, stored only as a hash", () => {
  assert.ok(TOKEN.test("tdn_" + "a".repeat(43)));
  assert.ok(!TOKEN.test("tdn_short"));
  assert.ok(!TOKEN.test("Bearer tdn_" + "a".repeat(43)));
  assert.match(hashToken("tdn_x"), /^[0-9a-f]{64}$/);
  assert.notEqual(hashToken("tdn_x"), "tdn_x");
});
