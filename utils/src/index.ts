/**
 * `@absolutejs/sync-pack-utils` — shared helpers extracted from the six
 * official `@absolutejs/sync` packs.
 *
 * Each helper closes one repeated pattern. The goal is to make new packs
 * (first- and third-party) cheaper to write and stop drift from the
 * standard shapes already shipped by presence / comments / digest /
 * notifications / favorites / counters.
 */

import {
	UnauthorizedError,
	type CollectionContext,
	type TableReader,
	type TableWriter
} from '@absolutejs/sync/engine';

// ─── Actor resolution ────────────────────────────────────────────────────────

/**
 * The conventional default — `(ctx) => ctx.userId`. Use as the fallback when
 * a pack's config doesn't supply its own `getActorId`.
 *
 * @example
 * const getActorId = config.getActorId ?? defaultGetActorId<MyCtx>();
 */
export const defaultGetActorId = <
	Ctx = CollectionContext
>(): ((ctx: Ctx) => string | undefined) =>
	(ctx) => (ctx as { userId?: string }).userId;

/**
 * Resolve the caller's actor id from a ctx, or throw {@link UnauthorizedError}
 * with a descriptive message. Use inside mutation handlers that require an
 * actor; the message embeds your `context` string so error reports name the
 * pack and operation.
 *
 * @example
 * const actorId = resolveActor(getActorId, ctx, 'comments:create');
 */
export const resolveActor = <Ctx = CollectionContext>(
	getActorId: (ctx: Ctx) => string | undefined,
	ctx: unknown,
	context: string
): string => {
	const actorId = getActorId(ctx as Ctx);
	if (actorId === undefined || actorId === '') {
		throw new UnauthorizedError(`${context} (no actor id)`);
	}
	return actorId;
};

// ─── Permission builders ─────────────────────────────────────────────────────

/**
 * Permission validator that requires `row[actorIdField] === getActorId(ctx)`.
 * Use for `insert` and `update` on rows the actor owns; the handler stamps
 * the actor on the row, so this is the canonical row-ownership check.
 *
 * @example
 * permissions: {
 *   notifications: {
 *     insert: requireRowOwner(getActorId, 'actorId'),
 *     update: requireRowOwner(getActorId, 'actorId'),
 *   },
 * },
 */
export const requireRowOwner =
	<Ctx = CollectionContext>(
		getActorId: (ctx: Ctx) => string | undefined,
		actorIdField: string = 'actorId'
	) =>
	(ctx: unknown, row: unknown): boolean => {
		const callerId = getActorId(ctx as Ctx);
		if (callerId === undefined) return false;
		const rowActor = (row as Record<string, unknown>)[actorIdField];
		return rowActor === callerId;
	};

/**
 * Permission validator for delete (or any op) that accepts the row OR
 * just its id. Falls back to `store.getById(row.id)` when the row's actor
 * field isn't on the supplied subject — sync's engine passes only the
 * key to `actions.delete({ id })`, so this pattern is needed for every
 * owner-gated delete.
 *
 * Returns true when the row's owner matches the caller OR `canModerate(ctx)`
 * is `true`.
 *
 * @example
 * permissions: {
 *   notifications: {
 *     delete: requireOwnerOrModerator({
 *       getActorId,
 *       canModerate,
 *       store,  // { getById }
 *       actorIdField: 'actorId',
 *     }),
 *   },
 * },
 */
export const requireOwnerOrModerator =
	<Ctx = CollectionContext>(options: {
		getActorId: (ctx: Ctx) => string | undefined;
		canModerate?: (ctx: Ctx) => boolean;
		store: { getById: (id: string) => unknown };
		actorIdField?: string;
	}) =>
	(ctx: unknown, row: unknown): boolean => {
		const {
			getActorId,
			canModerate,
			store,
			actorIdField = 'actorId'
		} = options;
		const callerId = getActorId(ctx as Ctx);
		if (callerId === undefined) return false;
		const supplied = row as Record<string, unknown>;
		const ownerId =
			supplied[actorIdField] !== undefined
				? supplied[actorIdField]
				: (() => {
						const id = supplied.id;
						if (typeof id !== 'string') return undefined;
						const stored = store.getById(id) as
							| Record<string, unknown>
							| undefined;
						return stored?.[actorIdField];
					})();
		if (ownerId === undefined) return false;
		if (ownerId === callerId) return true;
		return canModerate !== undefined ? canModerate(ctx as Ctx) : false;
	};

// ─── In-memory store ────────────────────────────────────────────────────────

/**
 * Standard in-memory store for a pack table. Every row needs an `id: string`
 * (the table's primary key); the writer is upsert-by-id. Used by every
 * official pack as the default backing store.
 */
export type InMemoryStore<Row extends { id: string }> = {
	reader: TableReader<CollectionContext>;
	writer: TableWriter<Row, CollectionContext, unknown>;
	/** Lookup by id — convenient for permission and mutation handlers. */
	getById: (id: string) => Row | undefined;
	/** Direct read of the underlying Map for advanced use; treat as read-only. */
	rows: Map<string, Row>;
};

/**
 * Build a fresh, isolated in-memory store. Each call gets its own Map, so
 * two pack instances on the same engine don't share state.
 *
 * @example
 * const store = config.store ?? createInMemoryStore<NotificationRow>();
 */
export const createInMemoryStore = <
	Row extends { id: string }
>(): InMemoryStore<Row> => {
	const rows = new Map<string, Row>();
	return {
		getById: (id) => rows.get(id),
		reader: {
			all: () => [...rows.values()]
		},
		rows,
		writer: {
			delete: (row) => {
				rows.delete((row as { id: string }).id);
			},
			insert: (data) => {
				rows.set(data.id, data);
				return data;
			},
			update: (data) => {
				const prior = rows.get(data.id);
				const merged = { ...(prior ?? {}), ...data } as Row;
				rows.set(data.id, merged);
				return merged;
			}
		}
	};
};
