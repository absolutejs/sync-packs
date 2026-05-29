/**
 * `@absolutejs/sync-pack-favorites` — per-actor saved resources.
 *
 * Owns a `favorites` table; rows are `(actorId, resourceKind, resourceId)`
 * triples with a stable primary key derived from them, so toggling
 * favorite/unfavorite is an upsert/delete with no extra bookkeeping.
 *
 * Each actor sees only their own rows. Optional `joinResources` registers
 * a `favorites-with-resource` join collection that pairs each favorite
 * with the host's resource row (same shape as comments-with-author from
 * the comments pack). Useful when the UI wants "title + body + favorited?"
 * in one subscription.
 */

import {
	defineCollection,
	defineJoinCollection,
	defineMutation,
	defineSchema,
	defineSyncPack,
	field,
	UnauthorizedError,
	type CollectionContext,
	type SyncPack,
	type TableReader,
	type TableWriter
} from '@absolutejs/sync/engine';

/** A single favorited resource for a single actor. */
export type FavoriteRow = {
	/** `${actorId}:${resourceKind}:${resourceId}` — deterministic so toggling is idempotent. */
	id: string;
	actorId: string;
	/** App-level resource type ("doc", "task", "issue", ...). Lets one inbox span multiple kinds. */
	resourceKind: string;
	resourceId: string;
	createdAt: number;
	/**
	 * When the actor pinned this favorite, or `null` when unpinned.
	 * Clients can sort pinned-first by descending `pinnedAt`. Set by the
	 * `favorites:pin` / `favorites:togglePin` mutations.
	 */
	pinnedAt: number | null;
};

/** A `FavoriteRow` paired with the host's resource row, from the optional join. */
export type FavoriteWithResource<ResourceRow = unknown> = FavoriteRow & {
	resource: ResourceRow;
};

export type FavoritesStore = {
	reader: TableReader<CollectionContext>;
	writer: TableWriter<FavoriteRow, CollectionContext, unknown>;
	getById: (id: string) => FavoriteRow | undefined;
};

export const createInMemoryFavoritesStore = (): FavoritesStore => {
	const rows = new Map<string, FavoriteRow>();
	return {
		getById: (id) => rows.get(id),
		reader: {
			all: () => [...rows.values()]
		},
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
				const merged = { ...(prior ?? {}), ...data } as FavoriteRow;
				rows.set(data.id, merged);
				return merged;
			}
		}
	};
};

export type JoinResourcesConfig<Ctx, ResourceRow = unknown> = {
	/**
	 * The host's resource table name. Surfaced in `readsTables` so the
	 * dependency graph is reviewable. Required when the join is enabled
	 * (no default — many apps have multiple resource tables).
	 */
	table: string;
	/** Get the host resource's id (the join field). Default `(row) => row.id`. */
	key?: (resource: ResourceRow) => string;
	/**
	 * Host-side hydrate for the resources side of the join. The pack
	 * passes the subscription params + ctx; this returns candidate
	 * resources. The engine inner-joins on
	 * `favorite.resourceId === resource.id`.
	 */
	hydrate: (
		params: { actorId: string | undefined; resourceKind?: string },
		ctx: Ctx
	) => Iterable<ResourceRow> | Promise<Iterable<ResourceRow>>;
};

export type FavoritesPackConfig<Ctx = CollectionContext, ResourceRow = unknown> = {
	prefix?: string;
	getActorId?: (ctx: Ctx) => string | undefined;
	/** Custom storage adapter. Default per-instance in-memory. */
	store?: FavoritesStore;
	/** Wall-clock. Default `Date.now`. */
	now?: () => number;
	/**
	 * Optional join collection. When set, registers
	 * `favorites-with-resource` and adds the resource table to
	 * `readsTables`.
	 */
	joinResources?: JoinResourcesConfig<Ctx, ResourceRow>;
};

const resolveActor = (
	getActorId: NonNullable<FavoritesPackConfig['getActorId']>,
	ctx: unknown
): string => {
	const actorId = getActorId(ctx as CollectionContext);
	if (actorId === undefined || actorId === '') {
		throw new UnauthorizedError('favorites mutation (no actor id)');
	}
	return actorId;
};

const rowId = (
	actorId: string,
	resourceKind: string,
	resourceId: string
): string => `${actorId}:${resourceKind}:${resourceId}`;

/**
 * Build a {@link SyncPack} that exposes a per-actor list of favorited
 * host-side resources. Optional join collection pairs each favorite with
 * its host resource row.
 */
export const createFavoritesPack = <
	Ctx = CollectionContext,
	ResourceRow = unknown
>(
	config: FavoritesPackConfig<Ctx, ResourceRow> = {}
): SyncPack => {
	const prefix = config.prefix ?? '';
	const table = `${prefix}favorites`;
	const collectionName = table;
	const joinCollectionName = `${prefix}favorites-with-resource`;
	const favoriteMutationName = `${prefix}favorites:favorite`;
	const unfavoriteMutationName = `${prefix}favorites:unfavorite`;
	const toggleMutationName = `${prefix}favorites:toggle`;
	const store = config.store ?? createInMemoryFavoritesStore();
	const now = config.now ?? Date.now;
	const getActorId = (config.getActorId ??
		((ctx: CollectionContext) =>
			(ctx as { userId?: string }).userId)) as (
		ctx: CollectionContext
	) => string | undefined;
	const joinResources = config.joinResources;
	const resourceKey = (joinResources?.key ?? ((row: unknown) =>
		(row as { id: string }).id)) as (resource: unknown) => string;

	type Params = { resourceKind?: string };

	const pack: SyncPack = {
		name: '@absolutejs/sync-pack-favorites',
		ownsTables: [table],
		readsTables:
			joinResources === undefined ? [] : [joinResources.table],
		version: '0.2.0',

		schemas: defineSchema({
			[table]: {
				fields: {
					id: field.string,
					actorId: field.string,
					resourceKind: field.string,
					resourceId: field.string,
					createdAt: field.number,
					pinnedAt: (value) =>
						value === null || typeof value === 'number'
				}
			}
		}),

		readers: { [table]: store.reader },
		writers: { [table]: store.writer },

		permissions: {
			[table]: {
				read: (ctx: unknown, row: FavoriteRow) => {
					const callerId = getActorId(ctx as CollectionContext);
					return callerId !== undefined && row.actorId === callerId;
				},
				insert: (ctx: unknown, row: FavoriteRow) => {
					const callerId = getActorId(ctx as CollectionContext);
					return callerId !== undefined && row.actorId === callerId;
				},
				update: (ctx: unknown, row: FavoriteRow) => {
					const callerId = getActorId(ctx as CollectionContext);
					return callerId !== undefined && row.actorId === callerId;
				},
				delete: (ctx: unknown, row: FavoriteRow) => {
					const callerId = getActorId(ctx as CollectionContext);
					if (callerId === undefined) return false;
					const ownerId =
						(row as { actorId?: string }).actorId ??
						(() => {
							const id = (row as { id?: string }).id;
							return id === undefined
								? undefined
								: store.getById(id)?.actorId;
						})();
					return ownerId === callerId;
				}
			}
		},

		collections: [
			defineCollection<FavoriteRow, Params, CollectionContext>({
				name: collectionName,
				tables: [table],
				key: (row) => row.id,
				hydrate: (params, ctx) => {
					const callerId = getActorId(ctx);
					if (callerId === undefined) return [];
					return (store.reader.all(ctx) as FavoriteRow[]).filter(
						(row) =>
							row.actorId === callerId &&
							(params.resourceKind === undefined ||
								row.resourceKind === params.resourceKind)
					);
				},
				match: (row, params, ctx) => {
					const callerId = getActorId(ctx);
					if (callerId === undefined || row.actorId !== callerId)
						return false;
					return (
						params.resourceKind === undefined ||
						row.resourceKind === params.resourceKind
					);
				},
				authorize: (_params, ctx) =>
					getActorId(ctx as CollectionContext) !== undefined
			})
		],

		mutations: [
			defineMutation<
				{ resourceKind: string; resourceId: string },
				CollectionContext,
				FavoriteRow
			>({
				name: favoriteMutationName,
				handler: async (args, ctx, actions) => {
					const actorId = resolveActor(getActorId, ctx);
					const id = rowId(actorId, args.resourceKind, args.resourceId);
					const existing = store.getById(id);
					if (existing !== undefined) return existing;
					const row: FavoriteRow = {
						actorId,
						createdAt: now(),
						id,
						pinnedAt: null,
						resourceId: args.resourceId,
						resourceKind: args.resourceKind
					};
					return (await actions.insert(table, row)) as FavoriteRow;
				}
			}),
			defineMutation<
				{ resourceKind: string; resourceId: string },
				CollectionContext,
				void
			>({
				name: unfavoriteMutationName,
				handler: async (args, ctx, actions) => {
					const actorId = resolveActor(getActorId, ctx);
					const id = rowId(actorId, args.resourceKind, args.resourceId);
					if (store.getById(id) === undefined) return;
					await actions.delete(table, { id });
				}
			}),
			// Convenience: toggle is one round-trip from the client.
			defineMutation<
				{ resourceKind: string; resourceId: string },
				CollectionContext,
				{ favorited: boolean }
			>({
				name: toggleMutationName,
				handler: async (args, ctx, actions) => {
					const actorId = resolveActor(getActorId, ctx);
					const id = rowId(actorId, args.resourceKind, args.resourceId);
					const existing = store.getById(id);
					if (existing === undefined) {
						const row: FavoriteRow = {
							actorId,
							createdAt: now(),
							id,
							pinnedAt: null,
							resourceId: args.resourceId,
							resourceKind: args.resourceKind
						};
						await actions.insert(table, row);
						return { favorited: true };
					}
					await actions.delete(table, { id });
					return { favorited: false };
				}
			}),
			// 0.2: pinning — flips a per-actor `pinnedAt` timestamp so
			// clients can sort pinned-first. Idempotent: pinning twice
			// keeps the original `pinnedAt`; unpinning a non-favorite is
			// a no-op.
			defineMutation<
				{ resourceKind: string; resourceId: string },
				CollectionContext,
				FavoriteRow
			>({
				name: `${prefix}favorites:pin`,
				handler: async (args, ctx, actions) => {
					const actorId = resolveActor(getActorId, ctx);
					const id = rowId(actorId, args.resourceKind, args.resourceId);
					const existing = store.getById(id);
					if (existing === undefined) {
						const row: FavoriteRow = {
							actorId,
							createdAt: now(),
							id,
							pinnedAt: now(),
							resourceId: args.resourceId,
							resourceKind: args.resourceKind
						};
						return (await actions.insert(
							table,
							row
						)) as FavoriteRow;
					}
					if (existing.pinnedAt !== null) return existing;
					return (await actions.update(table, {
						...existing,
						pinnedAt: now()
					})) as FavoriteRow;
				}
			}),
			defineMutation<
				{ resourceKind: string; resourceId: string },
				CollectionContext,
				FavoriteRow | undefined
			>({
				name: `${prefix}favorites:unpin`,
				handler: async (args, ctx, actions) => {
					const actorId = resolveActor(getActorId, ctx);
					const id = rowId(actorId, args.resourceKind, args.resourceId);
					const existing = store.getById(id);
					if (existing === undefined || existing.pinnedAt === null) {
						return existing;
					}
					return (await actions.update(table, {
						...existing,
						pinnedAt: null
					})) as FavoriteRow;
				}
			}),
			defineMutation<
				{ resourceKind: string; resourceId: string },
				CollectionContext,
				{ pinned: boolean }
			>({
				name: `${prefix}favorites:togglePin`,
				handler: async (args, ctx, actions) => {
					const actorId = resolveActor(getActorId, ctx);
					const id = rowId(actorId, args.resourceKind, args.resourceId);
					const existing = store.getById(id);
					if (existing === undefined) {
						const row: FavoriteRow = {
							actorId,
							createdAt: now(),
							id,
							pinnedAt: now(),
							resourceId: args.resourceId,
							resourceKind: args.resourceKind
						};
						await actions.insert(table, row);
						return { pinned: true };
					}
					if (existing.pinnedAt === null) {
						await actions.update(table, {
							...existing,
							pinnedAt: now()
						});
						return { pinned: true };
					}
					await actions.update(table, {
						...existing,
						pinnedAt: null
					});
					return { pinned: false };
				}
			})
		]
	};

	if (joinResources !== undefined) {
		const resourceHydrate = joinResources.hydrate;
		pack.joinCollections = [
			defineJoinCollection<
				FavoriteRow,
				unknown,
				FavoriteWithResource,
				Params,
				CollectionContext
			>({
				name: joinCollectionName,
				key: (out) => out.id,
				left: {
					table,
					hydrate: (params, ctx) => {
						const callerId = getActorId(ctx);
						if (callerId === undefined) return [];
						return (
							store.reader.all(ctx) as FavoriteRow[]
						).filter(
							(row) =>
								row.actorId === callerId &&
								(params.resourceKind === undefined ||
									row.resourceKind === params.resourceKind)
						);
					},
					key: (row) => row.id,
					on: (row) => row.resourceId,
					match: (row, params, ctx) => {
						const callerId = getActorId(ctx);
						if (callerId === undefined || row.actorId !== callerId)
							return false;
						return (
							params.resourceKind === undefined ||
							row.resourceKind === params.resourceKind
						);
					}
				},
				right: {
					table: joinResources.table,
					hydrate: (params, ctx) =>
						resourceHydrate(
							{
								actorId: getActorId(ctx),
								resourceKind: params.resourceKind
							},
							ctx as Ctx
						) as Iterable<unknown>,
					key: (resource) => resourceKey(resource),
					on: (resource) => resourceKey(resource)
				},
				select: (favorite, resource) => ({ ...favorite, resource }),
				authorize: (_params, ctx) =>
					getActorId(ctx as CollectionContext) !== undefined
			})
		];
	}

	return defineSyncPack(pack);
};
