import { test } from "node:test";
import assert from "node:assert/strict";
import {
    parsePolicy,
    resolvePolicy,
    intersectFolders,
    combineWithCeiling,
    canWrite,
    isWritable,
    describeAccess,
    makeAccessResolver,
    READ_ONLY_ACCESS,
    type AccessRule,
} from "./policy.js";

const id = (groups: string[], extra: Record<string, unknown> = {}) => ({ sub: "u1", groups, ...extra });

// --- parsePolicy ---

test("parsePolicy: unset is null (no policy)", () => {
    assert.equal(parsePolicy(undefined), null);
    assert.equal(parsePolicy(""), null);
    assert.equal(parsePolicy("   "), null);
});

test("parsePolicy: parses groups, readOnly and writeFolders", () => {
    const rules = parsePolicy(
        JSON.stringify([
            { group: "vault-admins", writeFolders: null },
            { group: "vault-editors", writeFolders: ["Projects", "/Inbox/"] },
            { group: "*", readOnly: true },
        ]),
    );
    assert.deepEqual(rules, [
        { group: "vault-admins", writeFolders: null },
        { group: "vault-editors", writeFolders: ["Projects", "Inbox"] },
        { group: "*", readOnly: true },
    ]);
});

test("parsePolicy: rejects non-JSON and non-array", () => {
    assert.throws(() => parsePolicy("{not json"), /not valid JSON/);
    assert.throws(() => parsePolicy('{"group":"x"}'), /must be a JSON array/);
});

test("parsePolicy: rejects a rule without a usable group", () => {
    assert.throws(() => parsePolicy('[{"writeFolders":[]}]'), /needs a non-empty "group"/);
    assert.throws(() => parsePolicy('[{"group":"  "}]'), /needs a non-empty "group"/);
    assert.throws(() => parsePolicy("[42]"), /must be an object/);
});

test("parsePolicy: rejects malformed writeFolders and readOnly", () => {
    assert.throws(() => parsePolicy('[{"group":"x","writeFolders":"Inbox"}]'), /must be an array/);
    assert.throws(() => parsePolicy('[{"group":"x","writeFolders":[1]}]'), /must be strings/);
    assert.throws(() => parsePolicy('[{"group":"x","readOnly":"yes"}]'), /must be a boolean/);
});

test("parsePolicy: readOnly true wins over writeFolders", () => {
    const rules = parsePolicy('[{"group":"x","readOnly":true,"writeFolders":["Inbox"]}]')!;
    assert.deepEqual(rules[0], { group: "x", readOnly: true });
});

// --- resolvePolicy ---

const RULES: AccessRule[] = [
    { group: "vault-admins", writeFolders: null },
    { group: "vault-editors", writeFolders: ["Projects", "Inbox"] },
    { group: "*", readOnly: true },
];

test("resolvePolicy: first matching rule wins, in order", () => {
    // A user in both editors and admins gets admins, since it comes first.
    assert.deepEqual(resolvePolicy(id(["vault-editors", "vault-admins"]), RULES), {
        readOnly: false,
        writeFolders: null,
    });
    assert.deepEqual(resolvePolicy(id(["vault-editors"]), RULES), {
        readOnly: false,
        writeFolders: ["Projects", "Inbox"],
    });
});

test("resolvePolicy: the catch-all applies to everyone else", () => {
    assert.deepEqual(resolvePolicy(id(["random"]), RULES), { readOnly: true, writeFolders: [] });
});

test("resolvePolicy: default deny when no rule matches", () => {
    const noCatchAll: AccessRule[] = [{ group: "vault-editors", writeFolders: ["Inbox"] }];
    assert.deepEqual(resolvePolicy(id(["random"]), noCatchAll), READ_ONLY_ACCESS);
    assert.deepEqual(resolvePolicy(undefined, noCatchAll), READ_ONLY_ACCESS);
});

// --- intersectFolders ---

test("intersectFolders: null means unrestricted on that side", () => {
    assert.equal(intersectFolders(null, null), null);
    assert.deepEqual(intersectFolders(null, ["A"]), ["A"]);
    assert.deepEqual(intersectFolders(["A"], null), ["A"]);
});

test("intersectFolders: keeps the narrower of two overlapping folders", () => {
    assert.deepEqual(intersectFolders(["Projects"], ["Projects/Active"]), ["Projects/Active"]);
    assert.deepEqual(intersectFolders(["Projects/Active"], ["Projects"]), ["Projects/Active"]);
    assert.deepEqual(intersectFolders(["A"], ["A"]), ["A"]);
});

test("intersectFolders: disjoint scopes yield nothing writable", () => {
    assert.deepEqual(intersectFolders(["Projects"], ["Inbox"]), []);
});

test("intersectFolders: does not treat sibling prefixes as overlapping", () => {
    // "MCP" must not match "MCP-private" — boundary awareness.
    assert.deepEqual(intersectFolders(["MCP"], ["MCP-private"]), []);
});

// --- combineWithCeiling ---

test("combineWithCeiling: a read-only ceiling forces read-only", () => {
    const acc = combineWithCeiling({ readOnly: false, writeFolders: null }, { readOnly: true, writeFolders: null });
    assert.deepEqual(acc, { readOnly: true, writeFolders: [] });
});

test("combineWithCeiling: a read-only policy forces read-only", () => {
    const acc = combineWithCeiling(READ_ONLY_ACCESS, { readOnly: false, writeFolders: null });
    assert.deepEqual(acc, { readOnly: true, writeFolders: [] });
});

test("combineWithCeiling: the ceiling narrows the policy's folders", () => {
    const acc = combineWithCeiling(
        { readOnly: false, writeFolders: null }, // policy: unrestricted
        { readOnly: false, writeFolders: ["Team"] }, // ceiling: Team only
    );
    assert.deepEqual(acc, { readOnly: false, writeFolders: ["Team"] });
});

test("combineWithCeiling: no overlap between ceiling and policy is read-only", () => {
    const acc = combineWithCeiling(
        { readOnly: false, writeFolders: ["Inbox"] },
        { readOnly: false, writeFolders: ["Projects"] },
    );
    assert.deepEqual(acc, { readOnly: true, writeFolders: [] });
});

// --- canWrite / isWritable ---

test("canWrite: true only when something is writable", () => {
    assert.equal(canWrite({ readOnly: false, writeFolders: null }), true);
    assert.equal(canWrite({ readOnly: false, writeFolders: ["Inbox"] }), true);
    assert.equal(canWrite({ readOnly: false, writeFolders: [] }), false);
    assert.equal(canWrite(READ_ONLY_ACCESS), false);
});

test("isWritable: enforces folder scope and denies when read-only", () => {
    const scoped = { readOnly: false, writeFolders: ["Inbox"] };
    assert.equal(isWritable(scoped, "Inbox/note.md"), true);
    assert.equal(isWritable(scoped, "Projects/note.md"), false);
    assert.equal(isWritable({ readOnly: false, writeFolders: null }, "anywhere.md"), true);
    assert.equal(isWritable(READ_ONLY_ACCESS, "Inbox/note.md"), false);
});

test("isWritable: blocks traversal even inside a writable folder", () => {
    assert.equal(isWritable({ readOnly: false, writeFolders: ["Inbox"] }, "Inbox/../secret.md"), false);
});

// --- describeAccess ---

test("describeAccess: readable summaries for denial messages", () => {
    assert.equal(describeAccess(READ_ONLY_ACCESS), "read-only");
    assert.equal(describeAccess({ readOnly: false, writeFolders: [] }), "read-only");
    assert.equal(describeAccess({ readOnly: false, writeFolders: null }), "the whole vault");
    assert.equal(describeAccess({ readOnly: false, writeFolders: ["Inbox", "Projects"] }), "Inbox/, Projects/");
});

// --- makeAccessResolver ---

test("makeAccessResolver: no policy gives every caller the ceiling", () => {
    const resolve = makeAccessResolver(null, { readOnly: false, writeFolders: ["Team"] });
    assert.deepEqual(resolve(undefined), { readOnly: false, writeFolders: ["Team"] });
    assert.deepEqual(resolve({ identity: id(["anything"]) }), { readOnly: false, writeFolders: ["Team"] });
});

test("makeAccessResolver: no policy, read-only ceiling → everyone read-only", () => {
    const resolve = makeAccessResolver(null, { readOnly: true, writeFolders: null });
    assert.equal(canWrite(resolve({ identity: id(["admins"]) })), false);
});

test("makeAccessResolver: resolves per identity when a policy is set", () => {
    const resolve = makeAccessResolver(RULES, { readOnly: false, writeFolders: null });
    assert.deepEqual(resolve({ identity: id(["vault-editors"]) }), {
        readOnly: false,
        writeFolders: ["Projects", "Inbox"],
    });
    assert.equal(canWrite(resolve({ identity: id(["random"]) })), false); // catch-all read-only
    assert.equal(canWrite(resolve(undefined)), false); // no identity → catch-all/deny
});

const adminSession = { authenticated: true, admin: true, identity: { sub: "admin", groups: ["vault-admins"] } };

test("makeAccessResolver: an admin session bypasses POLICY (full write)", () => {
    // Policy would make this identity read-only via the catch-all, but admin wins.
    const resolve = makeAccessResolver(RULES, { readOnly: false, writeFolders: null });
    assert.deepEqual(resolve(adminSession), { readOnly: false, writeFolders: null });
    assert.equal(canWrite(resolve(adminSession)), true);
});

test("makeAccessResolver: admin bypasses POLICY even with no policy set", () => {
    const resolve = makeAccessResolver(null, { readOnly: false, writeFolders: null });
    assert.equal(canWrite(resolve(adminSession)), true);
});

test("makeAccessResolver: admin does NOT bypass the ceiling", () => {
    // A read-only container stays read-only, even for the admin.
    const ro = makeAccessResolver(RULES, { readOnly: true, writeFolders: null });
    assert.equal(canWrite(ro(adminSession)), false);
    // A folder ceiling still pins the admin.
    const scoped = makeAccessResolver(null, { readOnly: false, writeFolders: ["Ops"] });
    assert.deepEqual(scoped(adminSession), { readOnly: false, writeFolders: ["Ops"] });
});

test("makeAccessResolver: policy is still narrowed by the ceiling", () => {
    const resolve = makeAccessResolver(RULES, { readOnly: false, writeFolders: ["Projects"] });
    // Admin is unrestricted by policy but the ceiling pins them to Projects.
    assert.deepEqual(resolve({ identity: id(["vault-admins"]) }), { readOnly: false, writeFolders: ["Projects"] });
    // Editor's Inbox falls outside the ceiling; only Projects survives.
    assert.deepEqual(resolve({ identity: id(["vault-editors"]) }), { readOnly: false, writeFolders: ["Projects"] });
});
