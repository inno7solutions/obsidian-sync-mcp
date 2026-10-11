/**
 * LiveSync Setup URI: an encrypted settings blob the Obsidian plugin imports
 * via "Use the copied setup URI". Port of deploy/generate-setup-uri.mjs, with
 * sync defaults that fit a server that also writes through MCP: LiveSync mode,
 * no batching, so changes reach CouchDB (and other clients) immediately.
 */

import { randomBytes } from "crypto";
import { encrypt } from "octagonal-wheels/encryption/encryption";

/** 128 random bits: a leaked URI must not be brute-forceable offline (it holds the CouchDB password and E2E passphrase). */
export function uriPassphrase(): string {
    return randomBytes(16).toString("base64url");
}

export interface SetupUriInput {
    couchdbUrl: string;
    username: string;
    password: string;
    database: string;
    passphrase?: string;
}

export async function makeSetupUri(input: SetupUriInput, uriPassphrase: string): Promise<string> {
    const conf = {
        couchDB_URI: input.couchdbUrl,
        couchDB_USER: input.username,
        couchDB_PASSWORD: input.password,
        couchDB_DBNAME: input.database,
        liveSync: true,
        syncOnStart: true,
        syncOnFileOpen: true,
        periodicReplication: false,
        batchSave: false,
        gcDelay: 0,
        encrypt: !!input.passphrase,
        passphrase: input.passphrase ?? "",
        usePathObfuscation: !!input.passphrase,
        batch_size: 50,
        batches_limit: 50,
        useHistory: true,
        disableRequestURI: true,
        customChunkSize: 60,
        syncAfterMerge: false,
        concurrencyOfReadChunksOnline: 100,
        minimumIntervalOfReadChunksOnline: 100,
        handleFilenameCaseSensitive: false,
        doNotUseFixedRevisionForChunks: true,
        usePluginSyncV2: true,
        E2EEAlgorithm: "v2",
        settingVersion: 10,
        notifyThresholdOfRemoteStorageSize: 800,
    };
    const blob = await encrypt(JSON.stringify(conf), uriPassphrase, false);
    return `obsidian://setuplivesync?settings=${encodeURIComponent(blob)}`;
}
