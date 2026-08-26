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
    ["comments", "docs_comments-search", "docs_comments:create", "normal"],
    [
      "favorites",
      "team_favorites-with-resource",
      "team_favorites:toggle",
      "critical",
    ],
    ["mentions", "ws_mentions", "ws_mentions:resolve", "normal"],
    [
      "notifications",
      "system_notifications",
      "system_notifications:markRead",
      "critical",
    ],
    ["triage", "inbox_triage", "inbox_triage:snooze", "critical"],
  ] as const)(
    "%s protects prefixed collections and mutations",
    async (directory, collectionName, mutationName, evictionPriority) => {
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
        onProtectionUnavailable: "memory-only",
        protection: "required",
        sensitivity: "private",
      });
      expect(resolveSyncLocalCollectionPolicy(policy, "unrelated")).toEqual({
        match: "unrelated",
      });
    },
  );

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
      persistence: "memory-only",
      sensitivity: "private",
    });
  });

  test("does not advertise client storage for the server-only utils package", async () => {
    const manifest = await packManifest("utils");
    expect(manifest.absolutejs?.sync).toBeUndefined();
  });
});
