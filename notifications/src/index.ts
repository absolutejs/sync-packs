/**
 * `@absolutejs/sync-pack-notifications` — per-actor inbox pack.
 *
 * Owns a `notifications` table. Each row is one notification for one actor.
 * The host calls `notifications:notify` to deliver; actors call
 * `notifications:markRead` or `notifications:markAllRead` from the client;
 * actors see only their own rows via the scoped collection.
 *
 * Optional `autoArchiveAfterDays` enables a cleanup schedule that removes
 * rows past their TTL. By default everything stays in the inbox.
 */

import {
	defineCollection,
	defineMutation,
	defineSchedule,
	defineSchema,
	defineSyncPack,
	exponentialBackoff,
	field,
	UnauthorizedError,
	type CollectionContext,
	type SyncPack,
	type TableReader,
	type TableWriter
} from '@absolutejs/sync/engine';

/** One notification for one actor. */
export type NotificationRow = {
	id: string;
	/** Whose inbox this belongs to. */
	actorId: string;
	/** App-level type tag — host can route on it (e.g. "mention", "reply"). */
	kind: string;
	title: string;
	body: string;
	/** Optional URL the client jumps to when the notification is clicked. */
	href: string | null;
	createdAt: number;
	readAt: number | null;
	/** Epoch ms after which the row is eligible for cleanup. Null = keep forever. */
	expiresAt: number | null;
};

/** Storage adapter the pack uses for the notifications table. */
export type NotificationsStore = {
	reader: TableReader<CollectionContext>;
	writer: TableWriter<NotificationRow, CollectionContext, unknown>;
	getById: (id: string) => NotificationRow | undefined;
	/** Used by the cleanup schedule when autoArchiveAfterDays is set. */
	expired: (now: number) => NotificationRow[];
};

/** Default in-memory store. */
export const createInMemoryNotificationsStore = (): NotificationsStore => {
	const rows = new Map<string, NotificationRow>();
	return {
		expired: (now) =>
			[...rows.values()].filter(
				(row) => row.expiresAt !== null && row.expiresAt <= now
			),
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
				const merged = { ...(prior ?? {}), ...data } as NotificationRow;
				rows.set(data.id, merged);
				return merged;
			}
		}
	};
};

/** Args for `notifications:notify`. Server-trusted; only the host calls this. */
export type NotifyArgs = {
	actorId: string;
	kind: string;
	title: string;
	body: string;
	href?: string | null;
	/** Override the pack-level autoArchiveAfterDays for this specific row. */
	expiresAt?: number | null;
};

/** Factory config. */
export type NotificationsPackConfig<Ctx = CollectionContext> = {
	/**
	 * Prefix applied to the owned table name AND every collection/mutation
	 * the pack exposes. Default `""`.
	 */
	prefix?: string;
	/**
	 * Extract the current actor id from the app's ctx. Default
	 * `(ctx) => ctx.userId`. Used to scope inbox reads and gate
	 * markRead to the row owner.
	 */
	getActorId?: (ctx: Ctx) => string | undefined;
	/**
	 * Optional moderator predicate. If `true`, the caller can mark any
	 * actor's row read (admin "clear all" tooling). Default `() => false`.
	 */
	canModerate?: (ctx: Ctx) => boolean;
	/**
	 * When set, every newly-inserted notification gets
	 * `expiresAt = createdAt + autoArchiveAfterDays * 86_400_000`, AND
	 * the pack registers a cleanup schedule that fires on
	 * `autoArchiveCron` and deletes expired rows. Default: archive
	 * disabled (rows live forever unless the host sets `expiresAt`
	 * per-call).
	 */
	autoArchiveAfterDays?: number;
	/**
	 * Cron pattern for the cleanup schedule. Only fires if
	 * `autoArchiveAfterDays` is set. Default `"0 * * * *"` (every hour).
	 */
	autoArchiveCron?: string;
	/**
	 * Custom storage adapter. Default: per-instance in-memory store.
	 */
	store?: NotificationsStore;
	/** Wall-clock. Default `Date.now`. */
	now?: () => number;
	/** Row id generator. Default `crypto.randomUUID()`. */
	newId?: () => string;
};

const DEFAULT_AUTO_ARCHIVE_CRON = '0 * * * *';
const MS_PER_DAY = 86_400_000;

const resolveActor = (
	getActorId: NonNullable<NotificationsPackConfig['getActorId']>,
	ctx: unknown
): string => {
	const actorId = getActorId(ctx as CollectionContext);
	if (actorId === undefined || actorId === '') {
		throw new UnauthorizedError('notifications mutation (no actor id)');
	}
	return actorId;
};

/**
 * Build a {@link SyncPack} that exposes a per-actor inbox.
 */
export const createNotificationsPack = <Ctx = CollectionContext>(
	config: NotificationsPackConfig<Ctx> = {}
): SyncPack => {
	const prefix = config.prefix ?? '';
	const table = `${prefix}notifications`;
	const collectionName = table;
	const notifyMutationName = `${prefix}notifications:notify`;
	const markReadMutationName = `${prefix}notifications:markRead`;
	const markAllReadMutationName = `${prefix}notifications:markAllRead`;
	const cleanupScheduleName = `${prefix}notifications:cleanup`;
	const store = config.store ?? createInMemoryNotificationsStore();
	const now = config.now ?? Date.now;
	const newId =
		config.newId ?? (() => globalThis.crypto.randomUUID());
	const getActorId = (config.getActorId ??
		((ctx: CollectionContext) =>
			(ctx as { userId?: string }).userId)) as (
		ctx: CollectionContext
	) => string | undefined;
	const canModerate = (config.canModerate ?? (() => false)) as (
		ctx: CollectionContext
	) => boolean;
	const autoArchiveAfterDays = config.autoArchiveAfterDays;
	const ttlMs =
		autoArchiveAfterDays !== undefined
			? autoArchiveAfterDays * MS_PER_DAY
			: undefined;
	const autoArchiveCron = config.autoArchiveCron ?? DEFAULT_AUTO_ARCHIVE_CRON;

	const pack: SyncPack = {
		name: '@absolutejs/sync-pack-notifications',
		ownsTables: [table],
		readsTables: [],
		version: '0.1.0',

		schemas: defineSchema({
			[table]: {
				fields: {
					id: field.string,
					actorId: field.string,
					kind: field.string,
					title: field.string,
					body: field.string,
					href: (value) => value === null || typeof value === 'string',
					createdAt: field.number,
					readAt: (value) =>
						value === null || typeof value === 'number',
					expiresAt: (value) =>
						value === null || typeof value === 'number'
				}
			}
		}),

		readers: { [table]: store.reader },
		writers: { [table]: store.writer },

		permissions: {
			[table]: {
				// Each actor sees their own inbox only. A moderator can see
				// any row.
				read: (ctx: unknown, row: NotificationRow) => {
					const callerId = getActorId(ctx as CollectionContext);
					if (callerId === undefined) return false;
					if (row.actorId === callerId) return true;
					return canModerate(ctx as CollectionContext);
				},
				// Inserts are trusted server-side (the notify handler is the
				// only path); permissions match the row's intended owner
				// so a host-side actions.insert with a forged actorId
				// would still need the caller's ctx to match. Tightens up.
				insert: (ctx: unknown, row: NotificationRow) => {
					const callerId = getActorId(ctx as CollectionContext);
					// The notify mutation is host-trusted; we run it with the
					// row.actorId as the target. We accept inserts when the
					// caller is the owner OR a moderator (i.e. the server
					// asking on behalf of someone else).
					if (callerId === undefined) return canModerate(ctx as CollectionContext);
					return row.actorId === callerId || canModerate(ctx as CollectionContext);
				},
				// Updates: owner-only (markRead) or moderator.
				update: (ctx: unknown, row: NotificationRow) => {
					const callerId = getActorId(ctx as CollectionContext);
					if (callerId === undefined) return false;
					if (row.actorId === callerId) return true;
					return canModerate(ctx as CollectionContext);
				},
				delete: (ctx: unknown, row: NotificationRow) => {
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
					if (ownerId === undefined) return false;
					return (
						ownerId === callerId ||
						canModerate(ctx as CollectionContext)
					);
				}
			}
		},

		collections: [
			defineCollection<NotificationRow, void, CollectionContext>({
				name: collectionName,
				tables: [table],
				key: (row) => row.id,
				hydrate: (_params, ctx) => {
					const callerId = getActorId(ctx);
					const isMod = canModerate(ctx);
					if (callerId === undefined && !isMod) return [];
					return (store.reader.all(ctx) as NotificationRow[]).filter(
						(row) => isMod || row.actorId === callerId
					);
				},
				match: (row, _params, ctx) => {
					const callerId = getActorId(ctx);
					if (canModerate(ctx)) return true;
					return callerId !== undefined && row.actorId === callerId;
				},
				authorize: (_params, ctx) =>
					getActorId(ctx as CollectionContext) !== undefined ||
					canModerate(ctx as CollectionContext)
			})
		],

		mutations: [
			// notifications:notify — host-trusted. The caller's ctx must be
			// a moderator OR match the target actorId, because the engine
			// runs the same permission check on insert.
			defineMutation<NotifyArgs, CollectionContext, NotificationRow>({
				name: notifyMutationName,
				handler: async (args, _ctx, actions) => {
					const t = now();
					const expiresAt =
						args.expiresAt !== undefined
							? args.expiresAt
							: ttlMs !== undefined
								? t + ttlMs
								: null;
					const row: NotificationRow = {
						actorId: args.actorId,
						body: args.body,
						createdAt: t,
						expiresAt,
						href: args.href ?? null,
						id: newId(),
						kind: args.kind,
						readAt: null,
						title: args.title
					};
					return (await actions.insert(table, row)) as
						NotificationRow;
				}
			}),
			// markRead — owner-only.
			defineMutation<
				{ notificationId: string },
				CollectionContext,
				NotificationRow
			>({
				name: markReadMutationName,
				handler: async (args, ctx, actions) => {
					const actorId = resolveActor(getActorId, ctx);
					const existing = store.getById(args.notificationId);
					if (existing === undefined) {
						throw new UnauthorizedError(
							`notifications:markRead on missing row "${args.notificationId}"`
						);
					}
					if (existing.actorId !== actorId) {
						throw new UnauthorizedError(
							`notifications:markRead on "${args.notificationId}" (not your row)`
						);
					}
					if (existing.readAt !== null) return existing;
					const updated: NotificationRow = {
						...existing,
						readAt: now()
					};
					return (await actions.update(table, updated)) as
						NotificationRow;
				}
			}),
			// markAllRead — owner's whole inbox.
			defineMutation<void, CollectionContext, { marked: number }>({
				name: markAllReadMutationName,
				handler: async (_args, ctx, actions) => {
					const actorId = resolveActor(getActorId, ctx);
					const t = now();
					const unread = (
						store.reader.all(ctx) as NotificationRow[]
					).filter(
						(row) => row.actorId === actorId && row.readAt === null
					);
					for (const row of unread) {
						await actions.update(table, { ...row, readAt: t });
					}
					return { marked: unread.length };
				}
			})
		]
	};

	if (autoArchiveAfterDays !== undefined) {
		pack.schedules = [
			defineSchedule({
				name: cleanupScheduleName,
				pattern: autoArchiveCron,
				retry: { backoff: exponentialBackoff(), maxAttempts: 3 },
				run: async ({ actions }) => {
					const t = now();
					for (const row of store.expired(t)) {
						await actions.delete(table, { id: row.id });
					}
				}
			})
		];
	}

	return defineSyncPack(pack);
};
