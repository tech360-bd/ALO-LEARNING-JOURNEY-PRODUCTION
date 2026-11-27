import test from "node:test";
import assert from "node:assert/strict";
import { cookiePairs, isSecureSessionCookie, toNetscapeJar } from "../scripts/verification/cookie-jar.mjs";

const SET_COOKIE = [
  "next-auth.csrf-token=abc%7Cdef; Path=/; HttpOnly; SameSite=Lax",
  "next-auth.callback-url=http%3A%2F%2F127.0.0.1%3A3061; Path=/; HttpOnly",
  "__Secure-next-auth.session-token=session-value; Path=/; HttpOnly; Secure; Expires=Wed, 27 Nov 2026 12:00:00 GMT",
];

test("attributes are stripped and every cookie survives", () => {
  assert.deepEqual(cookiePairs(SET_COOKIE), [
    "next-auth.csrf-token=abc%7Cdef",
    "next-auth.callback-url=http%3A%2F%2F127.0.0.1%3A3061",
    "__Secure-next-auth.session-token=session-value",
  ]);
});

test("a value containing '=' is not truncated", () => {
  // base64/JWT session tokens commonly end in '='; a naive split('=') would cut
  // the signature off and produce a cookie that looks right but never verifies.
  const [pair] = cookiePairs(["token=abcdef==; Path=/; HttpOnly"]);
  assert.equal(pair, "token=abcdef==");
});

test("clearing cookies are skipped, so they cannot overwrite a real session", () => {
  assert.deepEqual(
    cookiePairs([
      "next-auth.session-token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      "empty=; Path=/",
      'quoted=""',
      "real=kept; Path=/",
    ]),
    ["real=kept"]
  );
});

test("malformed headers are ignored instead of corrupting the jar", () => {
  assert.deepEqual(cookiePairs(["", "novalue", "=orphan", null, undefined]), []);
});

test("the jar uses the Netscape layout curl expects", () => {
  const jar = toNetscapeJar("http://127.0.0.1:3061", ["a=1", "b=2"], { now: 0 });
  const lines = jar.trimEnd().split("\n");
  assert.equal(lines[0], "# Netscape HTTP Cookie File");
  // Header comments, then one tab-separated record per cookie: 7 fields.
  const records = lines.filter((l) => !l.startsWith("#"));
  assert.equal(records.length, 2);
  for (const record of records) {
    const fields = record.split("\t");
    assert.equal(fields.length, 7, record);
    const [domain, includeSubdomains, path, secure, expiry, name, value] = fields;
    assert.equal(domain, "127.0.0.1");
    assert.equal(includeSubdomains, "FALSE");
    assert.equal(path, "/");
    assert.equal(secure, "FALSE");
    assert.equal(Number(expiry) > 0, true);
    assert.match(name, /^[ab]$/);
    assert.match(value, /^[12]$/);
  }
});

test("https targets are marked Secure, http ones are not", () => {
  const secureLine = toNetscapeJar("https://learn.alolabs.net", ["s=1"]).split("\n").find((l) => !l.startsWith("#"));
  assert.equal(secureLine.split("\t")[3], "TRUE");
  const plainLine = toNetscapeJar("http://127.0.0.1:3061", ["s=1"]).split("\n").find((l) => !l.startsWith("#"));
  assert.equal(plainLine.split("\t")[3], "FALSE");
});

test("a tab in a value cannot inject a second cookie record", () => {
  const jar = toNetscapeJar("http://127.0.0.1:3061", ["bad=va\tlue"]);
  assert.equal(jar.split("\n").filter((l) => !l.startsWith("#") && l.trim()).length, 0);
});

test("an unparseable origin yields an empty jar rather than throwing", () => {
  assert.equal(toNetscapeJar("not a url", ["a=1"]), "");
});

test("__Secure- and __Host- cookies are always written Secure", () => {
  // The app mints __Secure-next-auth.session-token in production. curl refuses to
  // send a Secure cookie over plain http, so a jar that marked it FALSE for an
  // http origin would authenticate nothing — the bug this flag prevents.
  assert.equal(isSecureSessionCookie("__Secure-next-auth.session-token"), true);
  assert.equal(isSecureSessionCookie("__Host-token"), true);
  assert.equal(isSecureSessionCookie("next-auth.session-token"), false);

  const jar = toNetscapeJar("http://127.0.0.1:3061", [
    "__Secure-next-auth.session-token=abc",
    "next-auth.csrf-token=def",
  ]);
  const records = jar.split("\n").filter((l) => !l.startsWith("#") && l.trim());
  const secureFlagOf = (name) => records.find((l) => l.split("\t")[5] === name).split("\t")[3];
  assert.equal(secureFlagOf("__Secure-next-auth.session-token"), "TRUE");
  assert.equal(secureFlagOf("next-auth.csrf-token"), "FALSE");
});
