import { describe, expect, test } from "bun:test";
import { createSyncEngine, type SyncEngine } from "@absolutejs/sync/engine";
import { expectRejection } from "@absolutejs/sync/testing";
import {
  createInMemoryTriageStore,
  createTriagePack,
  isMuted,
  isUnread,
  triageVisibility,
  type TriageRow,
  type TriageStatus,
} from "../src";

type Ctx = { userId?: string };
type Params = { resourceKind?: string; status?: TriageStatus };

const DAY_MS = 86_400_000;
const target = { resourceId: "thread-1", resourceKind: "thread" };

// `runMutation` is deliberately untyped on the engine (it dispatches by name),
// so the one cast in this file lives here rather than at every call site.
const run = async <Result>(
  engine: SyncEngine,
  name: string,
  args: unknown,
  ctx: Ctx,
): Promise<Result> => (await engine.runMutation(name, args, ctx)) as Result;

const packWith = (now?: () => number) =>
  createTriagePack<Ctx>({
    getActorId: (ctx) => ctx.userId,
    ...(now === undefined ? {} : { now }),
  });

const subscribe = (engine: SyncEngine, ctx: Ctx, params: Params = {}) =>
  engine.subscribe<TriageRow, Params, Ctx>({
    collection: "triage",
    ctx,
    onDiff: () => {},
    params,
  });

describe("triageVisibility", () => {
  const snoozed = {
    snoozedAt: 1_000,
    snoozedUntil: 5_000,
    status: "snoozed" as const,
    updatedAt: 1_000,
  };

  test("an unexpired snooze with no activity stays snoozed", () => {
    expect(triageVisibility(snoozed, { now: 2_000 })).toBe("snoozed");
  });

  test("an expired timer wakes the row", () => {
    expect(triageVisibility(snoozed, { now: 9_000 })).toBe("active");
  });

  test("activity after the snooze wakes it early", () => {
    expect(
      triageVisibility(snoozed, { lastActivityAt: 2_500, now: 2_000 }),
    ).toBe("active");
  });

  test("activity from BEFORE the snooze does not wake it", () => {
    expect(triageVisibility(snoozed, { lastActivityAt: 500, now: 2_000 })).toBe(
      "snoozed",
    );
  });

  test("an open-ended snooze sleeps until activity, not a timer", () => {
    const openEnded = { ...snoozed, snoozedUntil: null };
    expect(triageVisibility(openEnded, { now: 10_000_000 })).toBe("snoozed");
    expect(
      triageVisibility(openEnded, {
        lastActivityAt: 10_000,
        now: 10_000_000,
      }),
    ).toBe("active");
  });

  test("dismissed is terminal — new activity does NOT resurrect it", () => {
    const dismissed = {
      snoozedAt: null,
      snoozedUntil: null,
      status: "dismissed" as const,
      updatedAt: 1_000,
    };
    expect(
      triageVisibility(dismissed, {
        lastActivityAt: 9_999_999,
        now: 10_000_000,
      }),
    ).toBe("dismissed");
  });

  test("marking a snoozed row seen must not swallow earlier activity", () => {
    // updatedAt moves forward when the actor peeks; snoozedAt does not, and
    // snoozedAt is what the resurface rule reads.
    const peeked = { ...snoozed, updatedAt: 4_000 };
    expect(
      triageVisibility(peeked, { lastActivityAt: 2_500, now: 4_500 }),
    ).toBe("active");
  });
});

describe("isUnread / isMuted", () => {
  test("never seen is unread", () => {
    expect(isUnread({ lastSeenAt: null })).toBe(true);
  });

  test("seen with no later activity is read", () => {
    expect(isUnread({ lastSeenAt: 5_000 }, 4_000)).toBe(false);
  });

  test("activity after the last look is unread again", () => {
    expect(isUnread({ lastSeenAt: 5_000 }, 6_000)).toBe(true);
  });

  test("isMuted reflects the timestamp", () => {
    expect(isMuted({ mutedAt: null })).toBe(false);
    expect(isMuted({ mutedAt: 1 })).toBe(true);
  });
});

describe("createTriagePack", () => {
  test("seen: creates the row and only its owner can see it", async () => {
    const engine = createSyncEngine();
    engine.registerPack(packWith(() => 1_000));

    await run(engine, "triage:seen", target, { userId: "alice" });

    const alice = await subscribe(engine, { userId: "alice" });
    expect(alice.initial.length).toBe(1);
    expect(alice.initial[0]).toMatchObject({
      actorId: "alice",
      id: "alice:thread:thread-1",
      lastSeenAt: 1_000,
      status: "active",
    });

    const bob = await subscribe(engine, { userId: "bob" });
    expect(bob.initial.length).toBe(0);
  });

  test("the row id is deterministic, so repeat mutations upsert", async () => {
    const engine = createSyncEngine();
    const store = createInMemoryTriageStore<Ctx>();
    engine.registerPack(
      createTriagePack<Ctx>({ getActorId: (ctx) => ctx.userId, store }),
    );

    await run(engine, "triage:seen", target, { userId: "alice" });
    await run(engine, "triage:dismiss", target, { userId: "alice" });
    await run(engine, "triage:mute", target, { userId: "alice" });

    const rows = await store.all({ userId: "alice" });
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      mutedAt: expect.any(Number),
      status: "dismissed",
    });
  });

  test("unread clears lastSeenAt without touching status", async () => {
    const engine = createSyncEngine();
    engine.registerPack(packWith(() => 1_000));

    await run(engine, "triage:seen", target, { userId: "alice" });
    const row = await run<TriageRow>(engine, "triage:unread", target, {
      userId: "alice",
    });
    expect(row.lastSeenAt).toBeNull();
    expect(row.status).toBe("active");
  });

  test("dismiss stamps dismissedAt; restore clears it", async () => {
    const engine = createSyncEngine();
    engine.registerPack(packWith(() => 2_000));

    const dismissed = await run<TriageRow>(engine, "triage:dismiss", target, {
      userId: "alice",
    });
    expect(dismissed.status).toBe("dismissed");
    expect(dismissed.dismissedAt).toBe(2_000);

    const restored = await run<TriageRow>(engine, "triage:restore", target, {
      userId: "alice",
    });
    expect(restored.status).toBe("active");
    expect(restored.dismissedAt).toBeNull();
  });

  test("snooze records the baseline separately from updatedAt", async () => {
    let clock = 1_000;
    const engine = createSyncEngine();
    engine.registerPack(packWith(() => clock));

    const snoozed = await run<TriageRow>(
      engine,
      "triage:snooze",
      { ...target, snoozedUntil: 1_000 + DAY_MS },
      { userId: "alice" },
    );
    expect(snoozed.status).toBe("snoozed");
    expect(snoozed.snoozedAt).toBe(1_000);
    expect(snoozed.snoozedUntil).toBe(1_000 + DAY_MS);

    clock = 3_000;
    const peeked = await run<TriageRow>(engine, "triage:seen", target, {
      userId: "alice",
    });
    expect(peeked.snoozedAt).toBe(1_000);
    expect(peeked.updatedAt).toBe(3_000);
  });

  test("snooze without snoozedUntil sleeps until activity", async () => {
    const engine = createSyncEngine();
    engine.registerPack(packWith(() => 1_000));

    const row = await run<TriageRow>(engine, "triage:snooze", target, {
      userId: "alice",
    });
    expect(row.snoozedUntil).toBeNull();
    expect(row.status).toBe("snoozed");
  });

  test("mute and unmute leave status alone", async () => {
    const engine = createSyncEngine();
    engine.registerPack(packWith(() => 4_000));

    await run(engine, "triage:dismiss", target, { userId: "alice" });
    const muted = await run<TriageRow>(engine, "triage:mute", target, {
      userId: "alice",
    });
    expect(muted.mutedAt).toBe(4_000);
    expect(muted.status).toBe("dismissed");

    const unmuted = await run<TriageRow>(engine, "triage:unmute", target, {
      userId: "alice",
    });
    expect(unmuted.mutedAt).toBeNull();
    expect(unmuted.status).toBe("dismissed");
  });

  test("bulk applies one action to many resources in one call", async () => {
    const engine = createSyncEngine();
    engine.registerPack(packWith(() => 7_000));

    const written = await run<TriageRow[]>(
      engine,
      "triage:bulk",
      {
        action: "dismiss",
        resources: [
          { resourceId: "a", resourceKind: "thread" },
          { resourceId: "b", resourceKind: "thread" },
          { resourceId: "c", resourceKind: "thread" },
        ],
      },
      { userId: "alice" },
    );
    expect(written.length).toBe(3);
    expect(written.every((row) => row.status === "dismissed")).toBe(true);

    const view = await subscribe(
      engine,
      { userId: "alice" },
      { status: "dismissed" },
    );
    expect(view.initial.length).toBe(3);
  });

  test("bulk snooze passes snoozedUntil through", async () => {
    const engine = createSyncEngine();
    engine.registerPack(packWith(() => 1_000));

    const written = await run<TriageRow[]>(
      engine,
      "triage:bulk",
      {
        action: "snooze",
        resources: [{ resourceId: "a", resourceKind: "thread" }],
        snoozedUntil: 99_000,
      },
      { userId: "alice" },
    );
    expect(written[0]).toMatchObject({
      snoozedAt: 1_000,
      snoozedUntil: 99_000,
      status: "snoozed",
    });
  });

  test("bulk beyond maxBulkSize is rejected, not silently truncated", async () => {
    const engine = createSyncEngine();
    engine.registerPack(
      createTriagePack<Ctx>({
        getActorId: (ctx) => ctx.userId,
        maxBulkSize: 2,
      }),
    );

    const error = await expectRejection(() =>
      engine.runMutation(
        "triage:bulk",
        {
          action: "seen",
          resources: [
            { resourceId: "a", resourceKind: "thread" },
            { resourceId: "b", resourceKind: "thread" },
            { resourceId: "c", resourceKind: "thread" },
          ],
        },
        { userId: "alice" },
      ),
    );
    expect((error as Error).message).toMatch(/max 2/);
  });

  test("subscribing by status filters on effective visibility", async () => {
    let clock = 1_000;
    const engine = createSyncEngine();
    engine.registerPack(packWith(() => clock));

    await run(
      engine,
      "triage:snooze",
      {
        resourceId: "sleeping",
        resourceKind: "thread",
        snoozedUntil: 5_000,
      },
      { userId: "alice" },
    );
    await run(
      engine,
      "triage:seen",
      { resourceId: "awake", resourceKind: "thread" },
      { userId: "alice" },
    );

    const snoozedNow = await subscribe(
      engine,
      { userId: "alice" },
      { status: "snoozed" },
    );
    expect(snoozedNow.initial.map((row) => row.resourceId)).toEqual([
      "sleeping",
    ]);

    // Past the timer, the same row reads as active without any write.
    clock = 9_000;
    const activeLater = await subscribe(
      engine,
      { userId: "alice" },
      { status: "active" },
    );
    expect(activeLater.initial.map((row) => row.resourceId).sort()).toEqual([
      "awake",
      "sleeping",
    ]);
  });

  test("resourceKind scopes the subscription", async () => {
    const engine = createSyncEngine();
    engine.registerPack(packWith());

    await run(
      engine,
      "triage:seen",
      { resourceId: "1", resourceKind: "thread" },
      { userId: "alice" },
    );
    await run(
      engine,
      "triage:seen",
      { resourceId: "2", resourceKind: "task" },
      { userId: "alice" },
    );

    const tasks = await subscribe(
      engine,
      { userId: "alice" },
      { resourceKind: "task" },
    );
    expect(tasks.initial.map((row) => row.resourceId)).toEqual(["2"]);
  });

  test("writes without an actor id throw", async () => {
    const engine = createSyncEngine();
    engine.registerPack(packWith());

    const error = await expectRejection(() =>
      engine.runMutation("triage:seen", target, {}),
    );
    expect((error as Error).message).toMatch(/no actor id/);
  });

  test("the default getActorId reads ctx.userId", async () => {
    const engine = createSyncEngine();
    engine.registerPack(createTriagePack());

    const row = await run<TriageRow>(engine, "triage:seen", target, {
      userId: "alice",
    });
    expect(row.actorId).toBe("alice");
  });

  test("the wake sweep returns expired snoozes to active", async () => {
    let clock = 1_000;
    const store = createInMemoryTriageStore<Ctx>();
    const pack = createTriagePack<Ctx>({
      getActorId: (ctx) => ctx.userId,
      now: () => clock,
      store,
    });
    const engine = createSyncEngine();
    engine.registerPack(pack);
    expect(pack.schedules?.[0]?.name).toBe("triage:wake");

    await run(
      engine,
      "triage:snooze",
      { ...target, snoozedUntil: 5_000 },
      { userId: "alice" },
    );

    clock = 9_000;
    await engine.runSchedule("triage:wake");

    const rows = await store.all({ userId: "alice" });
    expect(rows[0]).toMatchObject({
      snoozedAt: null,
      snoozedUntil: null,
      status: "active",
    });
  });

  test("wakeCron: null skips registering the sweep", () => {
    const pack = createTriagePack<Ctx>({ wakeCron: null });
    expect(pack.schedules).toBeUndefined();
  });

  test("prefix namespaces every registered name", () => {
    const engine = createSyncEngine();
    engine.registerPack(createTriagePack<Ctx>({ prefix: "team_" }));

    const inspection = engine.inspect();
    expect(inspection.packs[0]?.ownsTables).toEqual(["team_triage"]);
    expect(inspection.mutations).toContain("team_triage:snooze");
    expect(inspection.mutations).toContain("team_triage:bulk");
    expect(inspection.collections.map((c) => c.name)).toContain("team_triage");
  });

  test("engine.inspect() surfaces the pack", () => {
    const engine = createSyncEngine();
    engine.registerPack(createTriagePack<Ctx>());
    expect(engine.inspect().packs).toEqual([
      {
        name: "@absolutejs/sync-pack-triage",
        ownsTables: ["triage"],
        readsTables: [],
        version: "0.1.0",
      },
    ]);
  });
});
