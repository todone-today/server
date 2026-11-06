import { test } from "node:test";
import assert from "node:assert/strict";
import { pushHost } from "../lib/push.ts";

test("push endpoints must be a browser push service", () => {
  for (const ok of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QAbc",
    "https://db5p.notify.windows.com/w/?token=abc",
  ])
    assert.ok(pushHost(ok), ok);
  for (const bad of [
    "http://fcm.googleapis.com/x",
    "https://fcm.googleapis.com.evil.io/x",
    "https://169.254.169.254/latest",
    "https://localhost/x",
    "https://fcm.googleapis.com:8443/x",
    "not a url",
  ])
    assert.ok(!pushHost(bad), bad);
});
