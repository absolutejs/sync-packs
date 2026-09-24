import { test, expect } from "bun:test";
import { createSyncEngine } from "@absolutejs/sync/engine";
import {
  createPersistentCommentsPack,
  validateCommentDraft,
  type PersistentComment,
} from "../src";
test("async ACL, actor stamping, private resources and transaction-aware append-only writes", async () => {
  const rows: PersistentComment[] = [];
  let revoked = false;
  const tx = { tag: "transaction" };
  const engine = createSyncEngine({ transaction: async (run) => run(tx) });
  engine.registerPack(
    createPersistentCommentsPack<{ user: string }, typeof tx>({
      table: "persistent_comments",
      dependencies: ["memberships"],
      getActorId: async (ctx) => ctx.user,
      canReadResource: async (id, ctx) =>
        !revoked && id === "allowed" && ctx.user !== "outsider",
      canWriteResource: async (_id, ctx) => ctx.user === "editor",
      canMention: async (id) => id === "viewer",
      store: {
        list: async () => rows,
        insert: async (row, _ctx, t) => {
          expect(t).toBe(tx);
          rows.push(row);
          return row;
        },
      },
    }),
  );
  const input = {
    resourceId: "allowed",
    body: "hello",
    mentions: ["viewer"],
    links: [{ label: "Reference", url: "https://example.com" }],
  };
  await expect(
    engine.runMutation("persistent_comments:create", input, { user: "viewer" }),
  ).rejects.toThrow();
  await expect(
    engine.runMutation(
      "persistent_comments:create",
      { ...input, resourceId: "private" },
      { user: "editor" },
    ),
  ).rejects.toThrow();
  await expect(
    engine.runMutation(
      "persistent_comments:create",
      { ...input, mentions: ["outsider"] },
      { user: "editor" },
    ),
  ).rejects.toThrow();
  const row = (await engine.runMutation("persistent_comments:create", input, {
    user: "editor",
  })) as PersistentComment;
  expect(row.authorId).toBe("editor");
  expect(rows).toHaveLength(1);
  const sub = await engine.subscribe<PersistentComment, { resourceId: string }>(
    {
      collection: "persistent_comments",
      params: { resourceId: "allowed" },
      ctx: { user: "viewer" },
      onDiff: () => {},
    },
  );
  expect(sub.initial).toHaveLength(1);
  revoked = true;
  await expect(
    engine.runMutation("persistent_comments:create", input, { user: "editor" }),
  ).rejects.toThrow();
  expect(rows).toHaveLength(1);
  sub.unsubscribe();
});
test("validates content, mentions and safe supporting links without accepting forged actor fields", () => {
  for (const data of [
    { resourceId: "x", body: " " },
    { resourceId: "x", body: "a", authorId: "forged" },
    {
      resourceId: "x",
      body: "a",
      links: [{ label: "x", url: "javascript:alert(1)" }],
    },
    {
      resourceId: "x",
      body: "a",
      links: [{ label: "x", url: "https://user:password@example.com" }],
    },
  ])
    expect(() => validateCommentDraft(data)).toThrow();
  expect(
    validateCommentDraft({
      resourceId: "x",
      body: "",
      mentions: ["a", "a"],
      links: [{ label: "", url: "https://example.com" }],
    }).mentions,
  ).toEqual(["a"]);
});
