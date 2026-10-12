import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error -- plain .mjs deploy script without types
import { fillEnv } from "../deploy/init-env.mjs";

test("init-env fills placeholders, keeps the rest, applies overrides, rejects unknown keys", () => {
    let n = 0;
    const example = "# comment\nUSER=admin\nPASS=<openssl rand -hex 16>\nKEY=<long-random-secret>\nURL=https://couch.example.com\n";
    const { text, generated } = fillEnv(example, { URL: "https://couch.acme.com" }, () => `secret${++n}`);
    assert.equal(text, "# comment\nUSER=admin\nPASS=secret1\nKEY=secret2\nURL=https://couch.acme.com\n");
    assert.deepEqual(generated, ["PASS", "KEY"]);
    assert.throws(() => fillEnv(example, { NOPE: "x" }), /Unknown key\(s\) not in \.env\.example: NOPE/);
    const real = fillEnv("A=<x>\nB=<x>").text.split("\n").map((l: string) => l.split("=")[1]);
    assert.notEqual(real[0], real[1], "each secret is random");
    assert.match(real[0], /^[0-9a-f]{64}$/);
});
