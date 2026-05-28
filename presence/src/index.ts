/**
 * `@absolutejs/sync-pack-presence` — per-channel live presence as a sync pack.
 *
 * Heartbeat-driven (actor calls `presence:heartbeat` every N seconds to keep
 * their row alive); scoped (each tenant/workspace sees its own actors);
 * TTL-cleaned (a `presence:cleanup` schedule deletes expired rows on cron).
 *
 * Ships an in-memory store by default — presence is ephemeral and almost
 * always fine to lose on restart. Host can pass a custom `store` for a
 * persistent backend (Drizzle, Postgres, Redis, …).
 *
 * @example
 * ```ts
 * import { createSyncEngine } from '@absolutejs/sync/engine';
 * import { createPresencePack } from '@absolutejs/sync-pack-presence';
 *
 * const engine = createSyncEngine();
 * engine.registerPack(createPresencePack({
 *   getActorId: (ctx) => ctx.session.userId,
 *   scope: (ctx) => ctx.session.workspaceId,
 *   heartbeatTtlSec: 30,
 * }));
 * ```
 */

import {
	defineCollection,
	defineMutation,
	defineSchedule,
	defineSchema,
	defineSyncPack,
	exponentialBackoff,
	field,
	type CollectionContext,
	type SyncPack,
	type TableReader,
	type TableWriter
} from '@absolutejs/sync/engine';

/** Per-actor presence row stored in the pack's owned table. */
export type PresenceRow<State = unknown> = {
	/**
	 * Row identity — derived from `${channel}:${actorId}`. One row per
	 * (channel, actor). Heartbeats upsert; leave deletes.
	 */
	id: string;
	channel: string;
	actorId: string;
	/**
	 * Scope value from the host's `scope(ctx)` config. The pack filters
	 * reads/writes by this — two scopes never see each other's presence.
	 */
	scope: string | null;
	/** Arbitrary payload the actor publishes (cursor pos, typing flag, etc). */
	state: State;
	/** Epoch ms after which the row is eligible for cleanup. */
	expiresAt: number;
	/** Epoch ms of the most recent heartbeat (also = expiresAt − ttl). */
	heartbeatAt: number;
};

/**
 * Storage adapter the pack uses to persist presence rows. Host passes a
 * custom store to use Postgres/Drizzle/etc.; the default is in-memory.
 */
export type PresenceStore<State = unknown> = {
	reader: TableReader<CollectionContext>;
	writer: TableWriter<PresenceRow<State>, CollectionContext, unknown>;
	/** Used by the cleanup schedule. Returns rows with `expiresAt <= now`. */
	expired: (now: number) => PresenceRow<State>[];
};

/**
 * Default in-memory store. Each pack instance creates its own store (so
 * two pack instances don't share state). Sized to keep one Map per
 * pack — presence sets are usually small (channels × actors).
 */
export const createInMemoryPresenceStore = <State = unknown>(): PresenceStore<
	State
> => {
	const rows = new Map<string, PresenceRow<State>>();
	return {
		reader: {
			all: () => [...rows.values()]
		},
		writer: {
			insert: (data) => {
				rows.set(data.id, data);
				return data;
			},
			update: (data) => {
				const prior = rows.get(data.id);
				const merged = { ...(prior ?? {}), ...data } as PresenceRow<
					State
				>;
				rows.set(data.id, merged);
				return merged;
			},
			delete: (row) => {
				rows.delete((row as { id: string }).id);
			}
		},
		expired: (now) =>
			[...rows.values()].filter((row) => row.expiresAt <= now)
	};
};

/** Factory config. All fields except `getActorId` have safe defaults. */
export type PresencePackConfig<Ctx = CollectionContext, State = unknown> = {
	/**
	 * Prefix applied to the owned table name AND every collection/mutation/
	 * schedule the pack exposes. Default `""`. Use a non-empty prefix when
	 * registering multiple presence packs on the same engine (e.g. one per
	 * product surface).
	 */
	prefix?: string;
	/**
	 * Extract the current actor's id from the app's ctx shape. **This is
	 * the only contract the pack assumes about the app's ctx.** Default:
	 * `(ctx) => ctx.userId`.
	 */
	getActorId?: (ctx: Ctx) => string | undefined;
	/**
	 * Optional tenant/workspace scope. When set, reads and writes are
	 * filtered by `scope(ctx)` — actors in different scopes never see
	 * each other. Default: `() => null` (no scoping).
	 */
	scope?: (ctx: Ctx) => string | null | undefined;
	/**
	 * Seconds a heartbeat keeps a presence row alive. The actor must
	 * re-call `presence:heartbeat` before this elapses, or the cleanup
	 * schedule will reap the row. Default `30`.
	 */
	heartbeatTtlSec?: number;
	/**
	 * Cron pattern for the cleanup schedule (`@elysiajs/cron` / croner
	 * syntax — optional 6th leading field is seconds). Default `*\/15 * *
	 * * * *` (every 15 seconds).
	 */
	cleanupCron?: string;
	/**
	 * Override the storage adapter. Default: a per-instance in-memory
	 * store. Pass your own for a persistent backend.
	 */
	store?: PresenceStore<State>;
	/**
	 * Wall-clock function. Default `Date.now`. Override in tests for
	 * deterministic TTL math.
	 */
	now?: () => number;
};

const DEFAULT_HEARTBEAT_TTL_SEC = 30;
const DEFAULT_CLEANUP_CRON = '*/15 * * * * *';

const resolveActorId = (
	getActorId: NonNullable<PresencePackConfig['getActorId']>,
	ctx: unknown
): string => {
	const actorId = getActorId(ctx as CollectionContext);
	if (actorId === undefined || actorId === '') {
		throw new Error('presence pack: getActorId(ctx) returned no actor id');
	}
	return actorId;
};

const resolveScope = (
	scope: PresencePackConfig['scope'],
	ctx: unknown
): string | null => {
	if (scope === undefined) return null;
	const value = scope(ctx as CollectionContext);
	return value ?? null;
};

/**
 * Build a {@link SyncPack} that exposes per-channel live presence. Each
 * call returns a fresh `SyncPack` (and a fresh default store, if none was
 * supplied), so two presence packs on the same engine — with different
 * prefixes — don't share state.
 */
export const createPresencePack = <
	Ctx = CollectionContext,
	State = unknown
>(
	config: PresencePackConfig<Ctx, State> = {}
): SyncPack => {
	const prefix = config.prefix ?? '';
	const table = `${prefix}presence`;
	const collectionName = table;
	const heartbeatMutationName = `${prefix}presence:heartbeat`;
	const leaveMutationName = `${prefix}presence:leave`;
	const cleanupScheduleName = `${prefix}presence:cleanup`;
	const ttlMs =
		(config.heartbeatTtlSec ?? DEFAULT_HEARTBEAT_TTL_SEC) * 1000;
	const cleanupCron = config.cleanupCron ?? DEFAULT_CLEANUP_CRON;
	const store = (config.store ?? createInMemoryPresenceStore<State>()) as
		PresenceStore<State>;
	const now = config.now ?? Date.now;
	const getActorId = (config.getActorId ??
		((ctx: CollectionContext) =>
			(ctx as { userId?: string }).userId)) as (
		ctx: CollectionContext
	) => string | undefined;
	const scope = config.scope as PresencePackConfig['scope'];

	type Params = { channel: string };

	return defineSyncPack({
		name: '@absolutejs/sync-pack-presence',
		ownsTables: [table],
		readsTables: [],
		version: '0.1.0',

		schemas: defineSchema({
			[table]: {
				fields: {
					id: field.string,
					channel: field.string,
					actorId: field.string,
					scope: (value) => value === null || typeof value === 'string',
					state: () => true,
					expiresAt: field.number,
					heartbeatAt: field.number
				}
			}
		}),

		readers: { [table]: store.reader },
		writers: { [table]: store.writer },

		permissions: {
			[table]: {
				read: (ctx: unknown, row: PresenceRow<State>) => {
					const callerScope = resolveScope(scope, ctx);
					return row.scope === callerScope;
				},
				// Writes are gated to "row.actorId === resolved caller".
				// The validator closes over the same `getActorId` the
				// handler uses, so a forged actorId in args is rejected
				// before the writer fires.
				insert: (ctx: unknown, row: PresenceRow<State>) => {
					const callerId = getActorId(ctx as CollectionContext);
					return callerId !== undefined && row.actorId === callerId;
				},
				update: (ctx: unknown, row: PresenceRow<State>) => {
					const callerId = getActorId(ctx as CollectionContext);
					return callerId !== undefined && row.actorId === callerId;
				},
				delete: (ctx: unknown, row: PresenceRow<State>) => {
					const callerId = getActorId(ctx as CollectionContext);
					if (callerId === undefined) return false;
					// `actions.delete` may receive either a full row or
					// just the row key. When only the key is supplied the
					// engine still calls permissions; in that case there's
					// no actorId to compare against, so we look it up from
					// the store. (Cheap: presence sets are small.)
					if ((row as { actorId?: string }).actorId !== undefined) {
						return (
							(row as { actorId: string }).actorId === callerId
						);
					}
					const id = (row as { id?: string }).id;
					if (id === undefined) return false;
					const existing = (
						store.reader.all(ctx as CollectionContext) as
							PresenceRow<State>[]
					).find((r) => r.id === id);
					return existing?.actorId === callerId;
				}
			}
		},

		collections: [
			defineCollection<PresenceRow<State>, Params, CollectionContext>({
				name: collectionName,
				tables: [table],
				key: (row) => row.id,
				hydrate: (params, ctx) => {
					const callerScope = resolveScope(scope, ctx);
					const t = now();
					return (
						store.reader.all(ctx) as PresenceRow<State>[]
					).filter(
						(row) =>
							row.channel === params.channel &&
							row.scope === callerScope &&
							row.expiresAt > t
					);
				},
				match: (row, params, ctx) => {
					const callerScope = resolveScope(scope, ctx);
					return (
						row.channel === params.channel &&
						row.scope === callerScope &&
						row.expiresAt > now()
					);
				},
				authorize: (_params, ctx) => {
					// Scoped reads — caller must produce a defined ctx; the
					// scope filter alone is enough since rows carry the
					// scope. We refuse only if `getActorId` cannot identify
					// the caller AND no scope was configured, to avoid
					// world-readable presence by accident.
					if (scope !== undefined) return true;
					return getActorId(ctx as CollectionContext) !== undefined;
				}
			})
		],

		mutations: [
			defineMutation<
				{ channel: string; state: State },
				CollectionContext,
				PresenceRow<State>
			>({
				name: heartbeatMutationName,
				handler: async (args, ctx, actions) => {
					const actorId = resolveActorId(getActorId, ctx);
					const callerScope = resolveScope(scope, ctx);
					const t = now();
					const row: PresenceRow<State> = {
						id: `${args.channel}:${actorId}`,
						channel: args.channel,
						actorId,
						scope: callerScope,
						state: args.state,
						expiresAt: t + ttlMs,
						heartbeatAt: t
					};
					// Heartbeats repeat — pick update vs insert from the
					// current store, so the writer's update path merges
					// by id instead of throwing on a duplicate key.
					const existing = (
						store.reader.all(ctx as CollectionContext) as
							PresenceRow<State>[]
					).some((r) => r.id === row.id);
					if (existing) {
						return (await actions.update(table, row)) as
							PresenceRow<State>;
					}
					return (await actions.insert(table, row)) as
						PresenceRow<State>;
				}
			}),
			defineMutation<{ channel: string }, CollectionContext, void>({
				name: leaveMutationName,
				handler: async (_args, ctx, actions) => {
					const actorId = resolveActorId(getActorId, ctx);
					await actions.delete(table, {
						id: `${_args.channel}:${actorId}`
					});
				}
			})
		],

		schedules: [
			defineSchedule({
				name: cleanupScheduleName,
				pattern: cleanupCron,
				retry: {
					maxAttempts: 3,
					backoff: exponentialBackoff()
				},
				run: async ({ actions }) => {
					const t = now();
					for (const row of store.expired(t)) {
						// Cleanup deletes bypass the actor permission check
						// because schedules run as trusted server code (the
						// engine doesn't enforce permissions on schedule
						// writes); the actorId stamp is unnecessary here.
						await actions.delete(table, { id: row.id });
					}
				}
			})
		]
	});
};
