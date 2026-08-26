import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  resolveSyncLocalCollectionPolicy,
  resolveSyncLocalDataPolicy,
  resolveSyncLocalMutationPolicy,
  type SyncLocalStoreSchemaComponent,
} from "@absolutejs/sync/client";

type PackManifest = {
  absolutejs?: {
    sync?: { localSchema?: Omit<SyncLocalStoreSchemaComponent, "id"> };
  };
  name: string;
};

const packManifest = async (directory: string) =>
  JSON.parse(
    await readFile(
      join(import.meta.dir, "..", "..", directory, "package.json"),
      "utf8",
    ),
  ) as PackManifest;

const packPolicy = async (directory: string) => {
  const manifest = await packManifest(directory);
  const localSchema = manifest.absolutejs?.sync?.localSchema;
  if (!localSchema) throw new Error(`${manifest.name} has no local schema`);

  return resolveSyncLocalDataPolicy({
    components: [{ ...localSchema, id: manifest.name }],
  });
};

describe("official pack local-data policies", () => {
  test.each([
    [
      "comments",
      "docs_comments-search",
      "docs_comments:create",
      "normal",
      "manual",
    ],
    [
      "favorites",
      "team_favorites-with-resource",
      "team_favorites:toggle",
      "critical",
      "manual",
    ],
    [
      "mentions",
      "ws_mentions",
      "ws_mentions:resolve",
      "normal",
      "client-wins",
    ],
    [
      "notifications",
      "system_notifications",
      "system_notifications:markRead",
      "critical",
      "client-wins",
    ],
    [
      "triage",
      "inbox_triage",
      "inbox_triage:snooze",
      "critical",
      "client-wins",
    ],
  ] as const)(
    "%s protects prefixed collections and mutations",
    async (
      directory,
      collectionName,
      mutationName,
      evictionPriority,
      conflictStrategy,
    ) => {
      const policy = await packPolicy(directory);
      expect(
        resolveSyncLocalCollectionPolicy(policy, collectionName),
      ).toMatchObject({
        evictionPriority,
        onProtectionUnavailable: "memory-only",
        protection: "required",
        sensitivity: "private",
      });
      expect(
        resolveSyncLocalMutationPolicy(policy, mutationName),
      ).toMatchObject({
        conflict: { strategy: conflictStrategy },
        onProtectionUnavailable: "memory-only",
        protection: "required",
        sensitivity: "private",
      });
      expect(resolveSyncLocalCollectionPolicy(policy, "unrelated")).toEqual({
        match: "unrelated",
      });
    },
  );

  test("retries idempotent favorite intents but retains toggle conflicts", async () => {
    const policy = await packPolicy("favorites");
    expect(
      resolveSyncLocalMutationPolicy(policy, "team_favorites:favorite"),
    ).toMatchObject({
      conflict: { maxAttempts: 1, strategy: "client-wins" },
    });
    for (const mutation of [
      "team_favorites:toggle",
      "team_favorites:togglePin",
    ])
      expect(resolveSyncLocalMutationPolicy(policy, mutation)).toMatchObject({
        conflict: { strategy: "manual" },
      });
  });

  test("protects derived counters and digest cursors with disposable caches", async () => {
    const counters = await packPolicy("counters");
    expect(
      resolveSyncLocalCollectionPolicy(counters, "team_counter:openTasks"),
    ).toMatchObject({
      evictionPriority: "disposable",
      onProtectionUnavailable: "memory-only",
      protection: "required",
      sensitivity: "private",
    });
    const digest = await packPolicy("digest");
    expect(
      resolveSyncLocalCollectionPolicy(digest, "customer_digest_cursors"),
    ).toMatchObject({
      evictionPriority: "disposable",
      onProtectionUnavailable: "memory-only",
      protection: "required",
      sensitivity: "private",
    });
  });

  test("keeps presence collections and mutations ephemeral on every platform", async () => {
    const policy = await packPolicy("presence");
    expect(
      resolveSyncLocalCollectionPolicy(policy, "docs_presence"),
    ).toMatchObject({
      evictionPriority: "disposable",
      persistence: "memory-only",
      sensitivity: "private",
    });
    expect(
      resolveSyncLocalMutationPolicy(policy, "docs_presence:heartbeat"),
    ).toMatchObject({
      conflict: { strategy: "server-wins" },
      persistence: "memory-only",
      sensitivity: "private",
    });
  });

  test("does not advertise client storage for the server-only utils package", async () => {
    const manifest = await packManifest("utils");
    expect(manifest.absolutejs?.sync).toBeUndefined();
  });
});
