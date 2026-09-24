import { test, expect } from "bun:test";
import { createSyncEngine } from "@absolutejs/sync/engine";
import {
  createPersistentNotificationsPack,
  validateNotificationPreferences,
  type PersistentNotification,
} from "../src";
test("persistent inbox scopes async reads and writes to the actor and current resource access", async () => {
  const rows: PersistentNotification[] = [
    {
      id: "a",
      actorId: "alice",
      resourceId: "task",
      kind: "mention",
      createdAt: 1,
      readAt: null,
    },
    {
      id: "b",
      actorId: "bob",
      resourceId: "task",
      kind: "mention",
      createdAt: 1,
      readAt: null,
    },
  ];
  let allowed = true;
  let preferencesActor = "";
  const tx = { token: true };
  const engine = createSyncEngine({ transaction: async (run) => run(tx) });
  engine.registerPack(
    createPersistentNotificationsPack<{ actor: string }, typeof tx>({
      table: "inbox",
      preferencesTable: "preferences",
      kinds: ["mention"],
      getActorId: async (c) => c.actor,
      canRead: async () => allowed,
      store: {
        list: async () => rows,
        get: async (id) => rows.find((r) => r.id === id),
        preferences: async () => ({
          values: { mention: { email: true, inApp: true } },
          updatedAt: null,
        }),
        markRead: async (id, actor, time, t) => {
          expect(t).toBe(tx);
          const row = rows.find((r) => r.id === id && r.actorId === actor)!;
          row.readAt = time;
          return row;
        },
        savePreferences: async (actor, values, _v, t) => {
          expect(t).toBe(tx);
          preferencesActor = actor;
          return { values, updatedAt: "new" };
        },
      },
    }),
  );
  const sub = await engine.subscribe<PersistentNotification, unknown>({
    collection: "inbox",
    params: {},
    ctx: { actor: "alice" },
    onDiff: () => {},
  });
  expect(sub.initial.map((r) => r.id)).toEqual(["a"]);
  await expect(
    engine.runMutation("inbox:markRead", { id: "b" }, { actor: "alice" }),
  ).rejects.toThrow();
  await engine.runMutation("inbox:markRead", { id: "a" }, { actor: "alice" });
  expect(rows[0]!.readAt).not.toBeNull();
  await engine.runMutation(
    "preferences:save",
    {
      values: { mention: { email: false, inApp: true } },
      expectedUpdatedAt: null,
      actorId: "bob",
    },
    { actor: "alice" },
  );
  expect(preferencesActor).toBe("alice");
  allowed = false;
  await expect(
    engine.runMutation("inbox:markRead", { id: "a" }, { actor: "alice" }),
  ).rejects.toThrow();
  sub.unsubscribe();
});
test("preferences require exact kinds and boolean channel values", () => {
  for (const value of [
    {},
    { mention: { email: "yes", inApp: true } },
    { mention: { email: true, inApp: true, admin: true } },
    {
      mention: { email: true, inApp: true },
      other: { email: true, inApp: true },
    },
  ])
    expect(() => validateNotificationPreferences(value, ["mention"])).toThrow();
});
