import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * A simulated provider call means "no SMS gateway is configured, nothing was
 * delivered". Storing that row as `sent` (and counting it in the broadcast
 * total) made an undelivered message look delivered in the CRM timeline and in
 * the audit event title. These tests pin the truthful mapping.
 */

const routes = [
  "src/app/api/sms/send/route.ts",
  "src/app/api/sms/otp/route.ts",
  "src/app/api/sms/broadcast/route.ts",
];

test("no SMS route rewrites a simulated result as sent", async () => {
  for (const file of routes) {
    const source = await read(file);
    assert.doesNotMatch(
      source,
      /status:\s*result\.status\s*===\s*['"]simulation['"]\s*\?\s*['"]sent['"]/,
      `${file} still maps simulation -> sent`,
    );
    assert.match(source, /status:\s*result\.status,/, `${file} must persist the real provider status`);
  }
});

test("broadcast counts a simulated recipient as simulated, not sent", async () => {
  const source = await read("src/app/api/sms/broadcast/route.ts");
  // Each counter is incremented exactly once; simulation must be handled first.
  const increments = source.match(/\b(sent|simulated|failed)\+\+/g) ?? [];
  assert.deepEqual(increments.sort(), ["failed++", "failed++", "sent++", "simulated++"]);
  assert.match(
    source,
    /if \(result\.status === 'simulation' \|\| result\.simulated\) simulated\+\+;\s*else if \(result\.status === 'failed'\) failed\+\+;\s*else sent\+\+;/,
  );
  // The response must expose the undelivered count separately from sent.
  assert.match(source, /undelivered:\s*simulated/);
  assert.match(source, /message:\s*simulated > 0/);
  assert.match(source, /title: `Broadcast to \$\{sent\} sent, \$\{simulated\} simulated, \$\{failed\} failed`/);
});

test("OTP reports otpSent only when a provider accepted the message", async () => {
  const source = await read("src/app/api/sms/otp/route.ts");
  assert.match(source, /otpSent:\s*result\.status === 'sent'/);
  assert.doesNotMatch(source, /otpSent:\s*result\.status !== 'failed'/);
});

test("a configured provider still marks the row sent", async () => {
  // Guard the fix in the other direction: a real send must not be recorded as
  // simulation, and the provider chain must keep returning `sent` on success.
  const chain = await read("src/lib/sms-provider-chain.ts");
  assert.match(chain, /status: 'sent'/);
  assert.match(chain, /status: 'simulation'/);
  const send = await read("src/app/api/sms/send/route.ts");
  assert.match(send, /if \(result\.simulated\) simulated\+\+|status: result\.status/);
});
