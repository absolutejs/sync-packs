import {
  defineSyncPack,
  defineCollection,
  defineMutation,
  UnauthorizedError,
  type SyncPack,
} from "@absolutejs/sync/engine";
export type PersistentNotification = {
  id: string;
  actorId: string;
  resourceId: string;
  kind: string;
  createdAt: number;
  readAt: number | null;
};
export type NotificationPreferences = Record<
  string,
  { email: boolean; inApp: boolean }
>;
export type PreferencesRecord = {
  values: NotificationPreferences;
  updatedAt: string | null;
};
type Awaitable<T> = T | Promise<T>;
export function validateNotificationPreferences(
  input: unknown,
  kinds: readonly string[],
): NotificationPreferences {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== kinds.length
  )
    throw Error("Invalid notification preferences");
  const values = input as NotificationPreferences;
  for (const kind of kinds) {
    const value = values[kind];
    if (
      !value ||
      typeof value.email !== "boolean" ||
      typeof value.inApp !== "boolean" ||
      Object.keys(value).some((k) => k !== "email" && k !== "inApp")
    )
      throw Error("Invalid notification preferences");
  }
  if (Object.keys(values).some((k) => !kinds.includes(k)))
    throw Error("Invalid notification preferences");
  return values;
}
export function createPersistentNotificationsPack<Ctx, Tx = unknown>(config: {
  table: string;
  preferencesTable: string;
  dependencies?: string[];
  kinds: readonly string[];
  getActorId: (ctx: Ctx) => Awaitable<string | undefined>;
  canRead: (row: PersistentNotification, ctx: Ctx) => Awaitable<boolean>;
  store: {
    list: (actorId: string) => Awaitable<PersistentNotification[]>;
    get: (id: string) => Awaitable<PersistentNotification | undefined>;
    markRead: (
      id: string,
      actorId: string,
      readAt: number,
      tx: Tx,
    ) => Awaitable<unknown>;
    preferences: (actorId: string) => Awaitable<PreferencesRecord>;
    /** Must atomically compare expectedUpdatedAt, save values and advance updatedAt. */
    savePreferences: (
      actorId: string,
      values: NotificationPreferences,
      expectedUpdatedAt: string | null,
      tx: Tx,
    ) => Awaitable<PreferencesRecord>;
  };
}): SyncPack {
  const { table, preferencesTable, store } = config;
  const own = async (id: string, ctx: Ctx) => {
    const actor = await config.getActorId(ctx),
      row = typeof id === "string" ? await store.get(id) : undefined;
    return (
      !!actor && row?.actorId === actor && (await config.canRead(row, ctx))
    );
  };
  const denied = () => {
    throw new UnauthorizedError(
      "notifications are created only by trusted host transactions",
    );
  };
  return defineSyncPack({
    name: "@absolutejs/sync-pack-notifications/persistent",
    version: "0.5.0",
    ownsTables: [table, preferencesTable],
    readsTables: config.dependencies ?? [],
    writers: {
      [table]: {
        insert: denied,
        delete: denied,
        update: async (input: { id: string }, raw: unknown, tx: unknown) => {
          const ctx = raw as Ctx;
          if (!(await own(input.id, ctx)))
            throw new UnauthorizedError("notification");
          return store.markRead(
            input.id,
            (await config.getActorId(ctx))!,
            Date.now(),
            tx as Tx,
          );
        },
      },
      [preferencesTable]: {
        insert: denied,
        delete: denied,
        update: async (
          input: { values: unknown; expectedUpdatedAt: string | null },
          raw: unknown,
          tx: unknown,
        ) => {
          const actor = await config.getActorId(raw as Ctx);
          if (!actor) throw new UnauthorizedError("notification preferences");
          if (
            input.expectedUpdatedAt !== null &&
            typeof input.expectedUpdatedAt !== "string"
          )
            throw Error("Invalid notification preference version");
          return store.savePreferences(
            actor,
            validateNotificationPreferences(input.values, config.kinds),
            input.expectedUpdatedAt,
            tx as Tx,
          );
        },
      },
    },
    collections: [
      defineCollection<PersistentNotification, unknown, Ctx>({
        name: table,
        tables: [table, ...(config.dependencies ?? [])],
        key: (row) => row.id,
        authorize: async (_p, ctx) => !!(await config.getActorId(ctx)),
        hydrate: async (_p, ctx) => {
          const actor = await config.getActorId(ctx);
          if (!actor) return [];
          const rows = await store.list(actor);
          const allowed = await Promise.all(
            rows.map(async (row) =>
              row.actorId === actor && (await config.canRead(row, ctx))
                ? row
                : null,
            ),
          );
          return allowed.filter((r): r is PersistentNotification => r !== null);
        },
      }),
    ],
    mutations: [
      defineMutation<{ id: string }, Ctx, unknown>({
        name: table + ":markRead",
        authorize: (args, ctx) => own(args?.id, ctx),
        handler: (args, _ctx, actions) =>
          actions.update(table, { id: args.id }),
      }),
      defineMutation<
        { values: NotificationPreferences; expectedUpdatedAt: string | null },
        Ctx,
        unknown
      >({
        name: preferencesTable + ":save",
        authorize: async (_args, ctx) => !!(await config.getActorId(ctx)),
        handler: (args, _ctx, actions) =>
          actions.update(preferencesTable, args),
      }),
    ],
  });
}
