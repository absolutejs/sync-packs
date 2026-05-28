/**
 * `@absolutejs/sync-pack-counters` — read-set-tracked live counts.
 *
 * Each counter is a `defineReactiveQuery` whose compute function reads
 * through `ctx.db` to derive a numeric value from host tables. The engine
 * re-runs the query (and pushes the new value to subscribers) whenever any
 * table it read changes — no manual invalidation, no operator graph, no
 * polling. Counters are derived views; the pack owns no tables.
 *
 * @example
 * ```ts
 * import { createSyncEngine } from '@absolutejs/sync/engine';
 * import { createCountersPack } from '@absolutejs/sync-pack-counters';
 *
 * const engine = createSyncEngine();
 * engine.registerReader('tasks',         { all: () => db.tasks.list() });
 * engine.registerReader('notifications', { all: () => db.notifications.list() });
 *
 * engine.registerPack(createCountersPack({
 *   counters: {
 *     openTasks: async ({ db }) =>
 *       (await db.all<Task>('tasks')).filter((task) => !task.done).length,
 *     unreadNotifications: async ({ db, ctx }) =>
 *       (await db.all<Notification>('notifications'))
 *         .filter((n) => n.actorId === ctx.userId && n.readAt === null)
 *         .length,
 *   },
 * }));
 *
 * // Subscribe to a single counter — emits one row { id, key, value }.
 * useSyncCollection<CounterRow>({ collection: 'counter:openTasks' });
 * ```
 */

import {
	defineReactiveQuery,
	defineSyncPack,
	type CollectionContext,
	type ReadHandle,
	type SyncPack
} from '@absolutejs/sync/engine';

/** One reactive count emission. */
export type CounterRow = {
	/** Row key — matches the counter's name. */
	id: string;
	key: string;
	value: number;
	/** Epoch ms the compute completed. Useful for "as of" labelling. */
	computedAt: number;
};

/** What a counter's `compute` sees. Same shape as a reactive query's run-context. */
export type CounterContext<Ctx> = {
	db: ReadHandle;
	ctx: Ctx;
};

/** Function form — convenience when no per-counter authorize override is needed. */
export type CounterCompute<Ctx> = (
	context: CounterContext<Ctx>
) => number | Promise<number>;

/** Full form — `compute` + per-counter `authorize` override. */
export type CounterDefinition<Ctx = CollectionContext> = {
	/**
	 * Compute the counter value. Reads through `db` are tracked — the
	 * query re-runs whenever any table this compute read changes. Use
	 * `db.where(...)` when possible for range-level dependencies that
	 * are cheaper than full-table.
	 */
	compute: CounterCompute<Ctx>;
	/**
	 * Optional access control. Return false (or throw) to deny the
	 * subscription. Default: any ctx with a defined `getActorId` value.
	 * For a "global" counter (e.g. site-wide stats visible to everyone),
	 * return `() => true`.
	 */
	authorize?: (ctx: Ctx) => boolean | Promise<boolean>;
};

/** A counter is either a bare compute function or a full definition object. */
export type CounterEntry<Ctx = CollectionContext> =
	| CounterCompute<Ctx>
	| CounterDefinition<Ctx>;

const asCounterDefinition = <Ctx>(
	entry: CounterEntry<Ctx>
): CounterDefinition<Ctx> =>
	typeof entry === 'function' ? { compute: entry } : entry;

export type CountersPackConfig<Ctx = CollectionContext> = {
	prefix?: string;
	/**
	 * Used by the default `authorize` to gate counter subscriptions to
	 * authenticated callers. Override `authorize` per-counter for global
	 * counters. Default `(ctx) => ctx.userId`.
	 */
	getActorId?: (ctx: Ctx) => string | undefined;
	/**
	 * Counter definitions keyed by name. Each value can be a bare compute
	 * function (the common case) or a full {@link CounterDefinition} when
	 * you need to override the default authorize.
	 */
	counters: Record<string, CounterEntry<Ctx>>;
};

const now = () => Date.now();

/**
 * Build a {@link SyncPack} that exposes read-set-tracked counters. Each
 * entry in `config.counters` becomes a separate reactive query named
 * `${prefix}counter:${key}` returning a single {@link CounterRow}.
 */
export const createCountersPack = <Ctx = CollectionContext>(
	config: CountersPackConfig<Ctx>
): SyncPack => {
	const prefix = config.prefix ?? '';
	const getActorId = (config.getActorId ??
		((ctx: CollectionContext) =>
			(ctx as { userId?: string }).userId)) as (
		ctx: CollectionContext
	) => string | undefined;

	const reactiveQueries = Object.entries(config.counters).map(
		([key, entry]) => {
			const counter = asCounterDefinition<Ctx>(entry);
			const collectionName = `${prefix}counter:${key}`;
			return defineReactiveQuery<CounterRow, void, CollectionContext>({
				name: collectionName,
				key: (row) => row.id,
				run: async ({ db, ctx }) => {
					const value = await counter.compute({
						ctx: ctx as Ctx,
						db
					});
					return [{ computedAt: now(), id: key, key, value }];
				},
				authorize: (_params, ctx) => {
					if (counter.authorize !== undefined) {
						return counter.authorize(ctx as Ctx);
					}
					return getActorId(ctx) !== undefined;
				}
			});
		}
	);

	return defineSyncPack({
		name: '@absolutejs/sync-pack-counters',
		ownsTables: [],
		readsTables: [],
		version: '0.1.0',
		reactiveQueries
	});
};
