/**
 * `@absolutejs/sync-pack-triage` — per-actor "I'll deal with it later" state.
 *
 * Owns a `triage` table of `(actorId, resourceKind, resourceId)` rows carrying
 * the four decisions every backlog surface ends up needing: has the actor SEEN
 * it, have they PUT IT AWAY, should it come BACK later, and should it stop
 * nagging. Threads, tasks, deal rooms, alerts, review queues — they all grow
 * the same four, and every app rebuilds them from scratch.
 *
 * Two behaviours here are the reason this is a pack and not just a table:
 *
 *   - **Dismiss sticks.** New activity does NOT resurrect something the actor
 *     put away. Otherwise "dismiss" quietly means "hide until it changes", the
 *     item reappears at the worst moment, and the actor stops trusting the
 *     control.
 *   - **Snooze resurfaces.** A snoozed item comes back the moment the other
 *     side acts, not when its timer happens to expire — waiting out a three-day
 *     snooze while a reply sits hidden is how a deal dies. This is the Gmail
 *     norm and the one people expect.
 *
 * Effective status is a PURE function of the row plus the host's last-activity
 * timestamp ({@link triageVisibility}), so a host can apply the same rule
 * inside its own SQL-backed list query without instantiating the pack. The
 * optional wake schedule exists only to turn an expired snooze into a real
 * change event for live subscribers; correctness never depends on it.
 */

import {
  defineCollection,
  defineMutation,
  defineSchedule,
  defineSchema,
  defineSyncPack,
  field,
  UnauthorizedError,
  type CollectionContext,
  type MutationActions,
  type SyncPack,
  type TableWriter,
} from "@absolutejs/sync/engine";

/** Where a resource sits in one actor's queue. */
export type TriageStatus = "active" | "dismissed" | "snoozed";

/** One resource's triage state for one actor. */
export type TriageRow = {
  /** `${actorId}:${resourceKind}:${resourceId}` — deterministic, so every
   *  mutation is an idempotent upsert needing no extra bookkeeping, and the
   *  owner is recoverable from the key alone. */
  id: string;
  actorId: string;
  /** App-level resource type ("thread", "task", "room", ...), so one actor's
   *  triage spans every surface in the product. */
  resourceKind: string;
  resourceId: string;
  status: TriageStatus;
  /** Last time the actor looked. `null` means never — i.e. unread. */
  lastSeenAt: number | null;
  /** When the current snooze was set. This, not `updatedAt`, is the baseline
   *  for resurfacing: marking a snoozed item seen must not silently push the
   *  baseline forward and swallow activity that arrived before it. */
  snoozedAt: number | null;
  /** When the current snooze expires. `null` snoozes indefinitely — the item
   *  then returns only on new activity. */
  snoozedUntil: number | null;
  /** When the actor put this away, for "recently dismissed" / undo affordances. */
  dismissedAt: number | null;
  /** "Stop notifying me about this" without putting it away. `null` when off. */
  mutedAt: number | null;
  updatedAt: number;
};

/**
 * Storage for the pack's one table. Both reads may be async, so a host can back
 * this with its real database rather than a mirror; the pack builds the
 * engine's `TableReader` from them.
 */
export type TriageStore<Ctx = CollectionContext> = {
  /** Every row the store holds. The pack filters it to the caller. */
  all: (ctx: Ctx) => Promise<TriageRow[]> | TriageRow[];
  getById: (
    id: string,
  ) => Promise<TriageRow | undefined> | TriageRow | undefined;
  writer: TableWriter<TriageRow, Ctx, unknown>;
};

export const createInMemoryTriageStore = <
  Ctx = CollectionContext,
>(): TriageStore<Ctx> => {
  const rows = new Map<string, TriageRow>();

  return {
    all: () => [...rows.values()],
    getById: (id) => rows.get(id),
    writer: {
      delete: (row: { id: string }) => {
        rows.delete(row.id);
      },
      insert: (data: TriageRow) => {
        rows.set(data.id, data);

        return data;
      },
      update: (data: TriageRow) => {
        const merged = { ...rows.get(data.id), ...data };
        rows.set(data.id, merged);

        return merged;
      },
    },
  };
};

export type TriageVisibilityInput = {
  /**
   * When the resource itself last changed — a new message, a new comment, a
   * counterparty action. Omit (or pass `null`) when the host has no activity
   * signal, in which case a snooze ends only on its timer.
   */
  lastActivityAt?: number | null;
  now?: number;
};

/**
 * The status an actor should actually see right now.
 *
 * `dismissed` is terminal until the actor restores it — deliberately, even when
 * the resource has since changed. `snoozed` becomes `active` when its timer
 * expires OR when the resource changed after the snooze was set, whichever
 * happens first.
 */
export const triageVisibility = (
  row: Pick<TriageRow, "snoozedAt" | "snoozedUntil" | "status" | "updatedAt">,
  input: TriageVisibilityInput = {},
): TriageStatus => {
  if (row.status !== "snoozed") return row.status;

  const at = input.now ?? Date.now();
  if (row.snoozedUntil !== null && row.snoozedUntil <= at) return "active";

  const activity = input.lastActivityAt;
  const since = row.snoozedAt ?? row.updatedAt;

  return activity !== undefined && activity !== null && activity > since
    ? "active"
    : "snoozed";
};

/**
 * Whether the actor has unseen activity: they never looked, or the resource
 * changed since they last did.
 */
export const isUnread = (
  row: Pick<TriageRow, "lastSeenAt">,
  lastActivityAt?: number | null,
): boolean => {
  if (row.lastSeenAt === null) return true;
  if (lastActivityAt === undefined || lastActivityAt === null) return false;

  return lastActivityAt > row.lastSeenAt;
};

/** Whether this row should suppress notifications for its resource. */
export const isMuted = (row: Pick<TriageRow, "mutedAt">): boolean =>
  row.mutedAt !== null;

/** The triage actions, named exactly as their mutations are. */
export type TriageAction =
  | "dismiss"
  | "mute"
  | "restore"
  | "seen"
  | "snooze"
  | "unmute"
  | "unread";

export type TriagePackConfig<Ctx = CollectionContext> = {
  /** Read the acting user's id from the subscription/mutation context.
   *  Default reads `ctx.userId`. */
  getActorId?: (ctx: Ctx) => string | undefined;
  /** Cap on resources per `triage:bulk` call. Default 500. */
  maxBulkSize?: number;
  /** Wall-clock. Default `Date.now`. */
  now?: () => number;
  /** Name prefix for the pack's table, collection, mutations, and schedule. */
  prefix?: string;
  /** Custom storage adapter. Default per-instance in-memory. */
  store?: TriageStore<Ctx>;
  /**
   * Cron pattern for the sweep that flips expired snoozes back to `active`.
   * Default every five minutes; pass `null` to skip registering it.
   *
   * This only makes an expiry produce a live change event. Reads are already
   * correct without it, because {@link triageVisibility} resolves the expiry
   * at read time — so a host that hasn't wired the `scheduled` plugin still
   * behaves correctly, just without a push at the moment of expiry.
   */
  wakeCron?: string | null;
};

/** What identifies a host resource in every mutation. */
export type TriageTarget = { resourceId: string; resourceKind: string };

export type TriageSnoozeArgs = TriageTarget & {
  /** Epoch ms to sleep until, or `null` to snooze until new activity. */
  snoozedUntil?: number | null;
};

export type TriageBulkArgs = {
  action: TriageAction;
  resources: TriageTarget[];
  /** Only read when `action` is `"snooze"`. */
  snoozedUntil?: number | null;
};

const DEFAULT_MAX_BULK_SIZE = 500;
const DEFAULT_WAKE_CRON = "*/5 * * * *";

/** Default actor resolution: `ctx.userId` when it is a string. Typed against
 *  `unknown` so it satisfies any host context type without a cast. */
const actorIdFromContext = (ctx: unknown): string | undefined => {
  if (typeof ctx !== "object" || ctx === null || !("userId" in ctx)) {
    return undefined;
  }
  const { userId } = ctx;

  return typeof userId === "string" ? userId : undefined;
};

const rowId = (
  actorId: string,
  resourceKind: string,
  resourceId: string,
): string => `${actorId}:${resourceKind}:${resourceId}`;

/** Row identity for the engine's reader, narrowed rather than cast — a row
 *  without a string id is a bug in the host's store, not a value to guess at. */
const readerKey = (row: unknown): string => {
  if (typeof row === "object" && row !== null && "id" in row) {
    const { id } = row;
    if (typeof id === "string") return id;
  }

  throw new TypeError("triage row is missing a string id");
};

type TriagePatch = Partial<Omit<TriageRow, "actorId" | "id" | "updatedAt">>;

/**
 * Build a {@link SyncPack} exposing per-actor triage state over the host's own
 * resources. Register it with `engine.registerPack(createTriagePack(...))`.
 */
export const createTriagePack = <Ctx = CollectionContext>(
  config: TriagePackConfig<Ctx> = {},
): SyncPack => {
  const prefix = config.prefix ?? "";
  const table = `${prefix}triage`;
  const now = config.now ?? Date.now;
  const store = config.store ?? createInMemoryTriageStore<Ctx>();
  const maxBulkSize = config.maxBulkSize ?? DEFAULT_MAX_BULK_SIZE;
  const wakeCron =
    config.wakeCron === undefined ? DEFAULT_WAKE_CRON : config.wakeCron;
  const getActorId: (ctx: Ctx) => string | undefined =
    config.getActorId ?? actorIdFromContext;

  const mutationName = (action: string) => `${table}:${action}`;

  const resolveActor = (ctx: Ctx): string => {
    const actorId = getActorId(ctx);
    if (actorId === undefined || actorId === "") {
      throw new UnauthorizedError("triage mutation (no actor id)");
    }

    return actorId;
  };

  // Every single-resource mutation is the same move: find-or-create this
  // actor's row for this resource, then apply a patch. Writing it once keeps
  // the eight mutations from drifting apart.
  const applyPatch = async (
    target: TriageTarget,
    actorId: string,
    actions: MutationActions,
    patch: TriagePatch,
  ): Promise<TriageRow> => {
    const id = rowId(actorId, target.resourceKind, target.resourceId);
    const existing = await store.getById(id);
    const base: TriageRow = existing ?? {
      actorId,
      dismissedAt: null,
      id,
      lastSeenAt: null,
      mutedAt: null,
      resourceId: target.resourceId,
      resourceKind: target.resourceKind,
      snoozedAt: null,
      snoozedUntil: null,
      status: "active",
      updatedAt: now(),
    };
    const row: TriageRow = { ...base, ...patch, updatedAt: now() };

    return existing === undefined
      ? actions.insert<TriageRow>(table, row)
      : actions.update<TriageRow>(table, row);
  };

  const patchFor = (
    action: TriageAction,
    snoozedUntil: number | null,
  ): TriagePatch => {
    if (action === "seen") return { lastSeenAt: now() };
    if (action === "unread") return { lastSeenAt: null };
    if (action === "mute") return { mutedAt: now() };
    if (action === "unmute") return { mutedAt: null };
    if (action === "dismiss") {
      return {
        dismissedAt: now(),
        snoozedAt: null,
        snoozedUntil: null,
        status: "dismissed",
      };
    }
    if (action === "restore") {
      return {
        dismissedAt: null,
        snoozedAt: null,
        snoozedUntil: null,
        status: "active",
      };
    }

    return {
      dismissedAt: null,
      snoozedAt: now(),
      snoozedUntil,
      status: "snoozed",
    };
  };

  const single = (action: TriageAction) =>
    defineMutation<TriageTarget, Ctx, TriageRow>({
      handler: (args, ctx, actions) =>
        applyPatch(args, resolveActor(ctx), actions, patchFor(action, null)),
      name: mutationName(action),
    });

  type Params = {
    /** Filter to one resource kind. Omit for every kind. */
    resourceKind?: string;
    /**
     * Filter to one effective status, resolved with
     * {@link triageVisibility} at `now()` and WITHOUT a per-row activity
     * timestamp — this pack owns triage state, not the host's activity
     * feed. A host that wants activity-aware resurfacing inside a live
     * query should join this table in its own collection and call
     * `triageVisibility` there with its own timestamp.
     */
    status?: TriageStatus;
  };

  const mine = (row: TriageRow, params: Params, ctx: Ctx) =>
    getActorId(ctx) === row.actorId &&
    (params.resourceKind === undefined ||
      row.resourceKind === params.resourceKind) &&
    (params.status === undefined ||
      triageVisibility(row, { now: now() }) === params.status);

  const ownedBy = (ctx: Ctx, row: TriageRow) => {
    const callerId = getActorId(ctx);

    return callerId !== undefined && row.actorId === callerId;
  };

  const pack: SyncPack = {
    collections: [
      defineCollection<TriageRow, Params, Ctx>({
        authorize: (_params, ctx) => getActorId(ctx) !== undefined,
        hydrate: async (params, ctx) => {
          if (getActorId(ctx) === undefined) return [];
          const rows = await store.all(ctx);

          return rows.filter((row) => mine(row, params, ctx));
        },
        key: (row) => row.id,
        match: mine,
        name: table,
        tables: [table],
      }),
    ],

    mutations: [
      single("seen"),
      single("unread"),
      // Put away. Stays away — see the note at the top of this file.
      single("dismiss"),
      single("restore"),
      single("mute"),
      single("unmute"),
      defineMutation<TriageSnoozeArgs, Ctx, TriageRow>({
        handler: (args, ctx, actions) =>
          applyPatch(
            args,
            resolveActor(ctx),
            actions,
            patchFor("snooze", args.snoozedUntil ?? null),
          ),
        name: mutationName("snooze"),
      }),
      // Selecting twenty rows and archiving them is the single most
      // common thing a queue UI does; without this the client fires
      // twenty round-trips and the list flickers through twenty diffs.
      defineMutation<TriageBulkArgs, Ctx, TriageRow[]>({
        handler: async (args, ctx, actions) => {
          const actorId = resolveActor(ctx);
          if (args.resources.length > maxBulkSize) {
            throw new Error(
              `triage:bulk received ${args.resources.length} resources (max ${maxBulkSize})`,
            );
          }
          const patch = patchFor(args.action, args.snoozedUntil ?? null);
          const written: TriageRow[] = [];
          // Sequential on purpose: each apply reads the row it is
          // about to write, so two applies to the same id in flight
          // would race into a lost update.
          for (const target of args.resources) {
            written.push(await applyPatch(target, actorId, actions, patch));
          }

          return written;
        },
        name: mutationName("bulk"),
      }),
    ],

    name: "@absolutejs/sync-pack-triage",
    ownsTables: [table],

    permissions: {
      [table]: {
        // The engine hands write rules the STORED row when the table's
        // reader has a `get` (it does, below), so these can't be
        // spoofed by a client-supplied payload.
        delete: ownedBy,
        insert: ownedBy,
        read: ownedBy,
        update: ownedBy,
      },
    },

    readers: {
      [table]: {
        all: (ctx: Ctx) => store.all(ctx),
        get: (key) => store.getById(String(key)),
        key: readerKey,
      },
    },

    readsTables: [],

    schemas: defineSchema({
      [table]: {
        fields: {
          actorId: field.string,
          dismissedAt: (value) => value === null || typeof value === "number",
          id: field.string,
          lastSeenAt: (value) => value === null || typeof value === "number",
          mutedAt: (value) => value === null || typeof value === "number",
          resourceId: field.string,
          resourceKind: field.string,
          snoozedAt: (value) => value === null || typeof value === "number",
          snoozedUntil: (value) => value === null || typeof value === "number",
          status: field.enum("active", "dismissed", "snoozed"),
          updatedAt: field.number,
        },
      },
    }),

    version: "0.1.0",

    writers: { [table]: store.writer },
  };

  if (wakeCron !== null) {
    pack.schedules = [
      defineSchedule({
        name: `${table}:wake`,
        pattern: wakeCron,
        run: async ({ actions, db }) => {
          const at = now();
          const rows = await db.all<TriageRow>(table);
          const due = rows.filter(
            (row) =>
              row.status === "snoozed" &&
              row.snoozedUntil !== null &&
              row.snoozedUntil <= at,
          );
          for (const row of due) {
            await actions.update<TriageRow>(table, {
              ...row,
              snoozedAt: null,
              snoozedUntil: null,
              status: "active",
              updatedAt: at,
            });
          }
        },
      }),
    ];
  }

  return defineSyncPack(pack);
};
