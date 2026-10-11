import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpServerName } from "./ui.js";

test("mcpServerName is derived from the public MCP host", () => {
    assert.equal(mcpServerName("http://localhost:8787/mcp"), "obsidian-localhost-vaults");
    assert.equal(mcpServerName("https://Vault.Example.com/mcp"), "obsidian-vault-example-com-vaults");
    assert.equal(mcpServerName("http://10.0.0.5:8787/mcp"), "obsidian-10-0-0-5-vaults");
    assert.equal(mcpServerName("not a url"), "obsidian-server-vaults");
});

test("single-vault URL and server name", async () => {
    const { singleVaultUrl } = await import("./ui.js");
    assert.equal(singleVaultUrl("http://localhost:8787/mcp", "team-notes"), "http://localhost:8787/mcp?vault=team-notes");
    assert.equal(mcpServerName("https://vault.example.com/mcp", "team-notes"), "obsidian-vault-example-com-team-notes");
});
