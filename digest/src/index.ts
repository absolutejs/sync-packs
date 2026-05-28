/**
 * `@absolutejs/sync-pack-digest` — scheduled per-actor digest pack for
 * `@absolutejs/sync`.
 *
 * Cron-fires a schedule that iterates the host's actor list, asks the host
 * to build a digest payload for each actor since their last cursor, and
 * dispatches it through a host-provided `send` adapter. Owns one table
 * (`digest_cursors`) with one row per actor; nothing else.
 *
 * Per-actor failures are caught and logged so one bad send doesn't block
 * the rest. The whole-handler retry shim from sync 1.9.0 is wired but off
 * by default (digest fires are usually fine to skip on transient infra
 * failures — the next cron fire catches up).
 *
 * @example
 * ```ts
 * import { createSyncEngine } from '@absolutejs/sync/engine';
 * import { createDigestPack } from '@absolutejs/sync-pack-digest';
 *
 * const engine = createSyncEngine();
 * engine.registerPack(createDigestPack({
 *   cron: '0 8 * * 1', // Mondays 8am
 *   listActors: () => db.users.allActiveIds(),
 *   buildDigest: async (actorId, since) => {
 *     const items = await db.feed.since(actorId, since ?? new Date(0));
 *     if (items.length === 0) return null;
 *     return {
 *       to: await db.users.email(actorId),
 *       subject: `Your weekly digest`,
 *       body: render(items),
 *     };
 *   },
 *   send: async (msg) => await resend.send(msg),
 * }));
 * ```
 */

import {
	defineCollection,
	defineSchedule,
	defineSchema,
	defineSyncPack,
	field,
	type CollectionContext,
	type RetryPolicy,
	type SyncPack,
	type TableReader,
	type TableWriter
} from '@absolutejs/sync/engine';

/** One row per actor — created on first successful send, updated after each. */
export type DigestCursor = {
	/** Row id (= actorId). */
	id: string;
	actorId: string;
	/** Epoch ms of the most recent successful send. */
	lastSentAt: number;
	/** Subject line of the most recent successful send (for observability). */
	lastSubject: string;
};

/** The payload the host's `buildDigest` returns. Returning `null` skips. */
export type DigestPayload = {
	to: string;
	subject: string;
	body: string;
};

/** Storage adapter the pack uses for the cursors table. */
export type DigestStore = {
	reader: TableReader<CollectionContext>;
	writer: TableWriter<DigestCursor, CollectionContext, unknown>;
	getById: (id: string) => DigestCursor | undefined;
};

/** Default in-memory store. */
export const createInMemoryDigestStore = (): DigestStore => {
	const rows = new Map<string, DigestCursor>();
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
				const merged = { ...(prior ?? {}), ...data } as DigestCursor;
				rows.set(data.id, merged);
				return merged;
			}
		}
	};
};

const DEFAULT_CRON = '0 8 * * 1';
const DEFAULT_MAX_ACTORS_PER_FIRE = 1000;
const DEFAULT_MIN_HOURS_BETWEEN_DIGESTS = 168;

/** Factory config. `send`, `buildDigest`, and `listActors` are required. */
export type DigestPackConfig<Ctx = CollectionContext> = {
	/**
	 * Prefix applied to the owned table name AND every collection/schedule
	 * the pack exposes. Default `""`.
	 */
	prefix?: string;
	/**
	 * Cron pattern for the digest fire (`@elysiajs/cron` / croner syntax).
	 * Default `"0 8 * * 1"` (Mondays 08:00).
	 */
	cron?: string;
	/**
	 * Host-supplied email sender. The pack does NOT own transport (no SMTP
	 * client, no Resend/SES/Postmark dep). Throws are caught per-actor.
	 */
	send: (msg: DigestPayload) => Promise<void>;
	/**
	 * Build the digest payload for one actor. `since` is the actor's last
	 * successful send timestamp, or `null` if they've never received one.
	 * Return `null` to skip this fire silently (no content for this actor).
	 */
	buildDigest: (
		actorId: string,
		since: Date | null
	) => Promise<DigestPayload | null>;
	/**
	 * Yield the actor ids the schedule should iterate per fire. The host's
	 * own data layer is the source of truth for "who exists" — the pack
	 * just maintains per-actor cursors.
	 */
	listActors: () =>
		| Iterable<string>
		| Promise<Iterable<string>>;
	/**
	 * Cap on actors processed per fire (back-pressure). The rest wait for
	 * the next cron fire. Default `1000`.
	 */
	maxActorsPerFire?: number;
	/**
	 * Minimum hours between digests for a given actor. An actor whose
	 * cursor is fresher than this is skipped on the fire. Default `168`
	 * (one week — matches the weekly default cron).
	 */
	minHoursBetweenDigests?: number;
	/**
	 * Extract the current actor id from ctx — used to scope the cursor
	 * collection so each actor sees their own row. Default
	 * `(ctx) => ctx.userId`.
	 */
	getActorId?: (ctx: Ctx) => string | undefined;
	/**
	 * Outer schedule retry policy. The pack catches per-actor failures
	 * already, so this only retries the whole handler on classified
	 * transient infrastructure failures (e.g. DB serialization). Default
	 * undefined — digest fires miss skip on infra failure and catch up
	 * next cron.
	 */
	retry?: RetryPolicy;
	/** Override the storage adapter. Default: per-instance in-memory. */
	store?: DigestStore;
	/** Wall-clock function. Default `Date.now`. */
	now?: () => number;
	/**
	 * Hook for surfacing per-actor failures. Defaults to `console.error`.
	 * The pack swallows the error after this call so the schedule keeps
	 * going for the rest of the actor list.
	 */
	onActorFailure?: (info: {
		actorId: string;
		phase: 'buildDigest' | 'send' | 'cursor';
		error: unknown;
	}) => void;
};

const resolveActor = (
	getActorId: NonNullable<DigestPackConfig['getActorId']>,
	ctx: unknown
): string | undefined => getActorId(ctx as CollectionContext);

/**
 * Build a {@link SyncPack} that exposes scheduled per-actor digests. Each
 * call returns a fresh pack with its own cursor store (unless overridden).
 */
export const createDigestPack = <Ctx = CollectionContext>(
	config: DigestPackConfig<Ctx>
): SyncPack => {
	const prefix = config.prefix ?? '';
	const table = `${prefix}digest_cursors`;
	const collectionName = table;
	const scheduleName = `${prefix}digest:fire`;
	const cron = config.cron ?? DEFAULT_CRON;
	const maxActorsPerFire =
		config.maxActorsPerFire ?? DEFAULT_MAX_ACTORS_PER_FIRE;
	const minIntervalMs =
		(config.minHoursBetweenDigests ??
			DEFAULT_MIN_HOURS_BETWEEN_DIGESTS) *
		60 *
		60 *
		1000;
	const store = config.store ?? createInMemoryDigestStore();
	const now = config.now ?? Date.now;
	const getActorId = (config.getActorId ??
		((ctx: CollectionContext) =>
			(ctx as { userId?: string }).userId)) as (
		ctx: CollectionContext
	) => string | undefined;
	const onActorFailure =
		config.onActorFailure ??
		((info) => {
			// eslint-disable-next-line no-console
			console.error(
				`[sync-pack-digest] actor "${info.actorId}" failed at ${info.phase}:`,
				info.error
			);
		});

	const pack: SyncPack = {
		name: '@absolutejs/sync-pack-digest',
		ownsTables: [table],
		readsTables: [],
		version: '0.1.0',

		schemas: defineSchema({
			[table]: {
				fields: {
					id: field.string,
					actorId: field.string,
					lastSentAt: field.number,
					lastSubject: field.string
				}
			}
		}),

		readers: { [table]: store.reader },
		writers: { [table]: store.writer },

		permissions: {
			[table]: {
				// Each actor sees only their own cursor — the cursor row
				// surfaces "your last digest was at X" to the user without
				// leaking other actors' state. Hosts who want a global
				// admin view register their own permissions on top.
				read: (ctx: unknown, row: DigestCursor) => {
					const callerId = resolveActor(getActorId, ctx);
					return callerId !== undefined && row.actorId === callerId;
				},
				// Writes flow only through the pack's schedule; deny
				// outside writers by stamping actorId === caller, which
				// fails for any non-actor (the schedule runs trusted and
				// bypasses these checks).
				insert: (ctx: unknown, row: DigestCursor) => {
					const callerId = resolveActor(getActorId, ctx);
					return callerId !== undefined && row.actorId === callerId;
				},
				update: (ctx: unknown, row: DigestCursor) => {
					const callerId = resolveActor(getActorId, ctx);
					return callerId !== undefined && row.actorId === callerId;
				},
				delete: (ctx: unknown, row: DigestCursor) => {
					const callerId = resolveActor(getActorId, ctx);
					if (callerId === undefined) return false;
					if ((row as { actorId?: string }).actorId !== undefined) {
						return (row as { actorId: string }).actorId === callerId;
					}
					const id = (row as { id?: string }).id;
					if (id === undefined) return false;
					return store.getById(id)?.actorId === callerId;
				}
			}
		},

		collections: [
			defineCollection<DigestCursor, void, CollectionContext>({
				name: collectionName,
				tables: [table],
				key: (row) => row.id,
				hydrate: (_params, ctx) => {
					const callerId = resolveActor(getActorId, ctx);
					if (callerId === undefined) return [];
					return (store.reader.all(ctx) as DigestCursor[]).filter(
						(row) => row.actorId === callerId
					);
				},
				match: (row, _params, ctx) => {
					const callerId = resolveActor(getActorId, ctx);
					return (
						callerId !== undefined && row.actorId === callerId
					);
				},
				authorize: (_params, ctx) =>
					resolveActor(getActorId, ctx) !== undefined
			})
		],

		schedules: [
			defineSchedule({
				name: scheduleName,
				pattern: cron,
				...(config.retry !== undefined ? { retry: config.retry } : {}),
				run: async ({ actions }) => {
					const t = now();
					const actors = await config.listActors();
					let processed = 0;
					for (const actorId of actors) {
						if (processed >= maxActorsPerFire) break;
						const cursor = store.getById(actorId);
						if (
							cursor !== undefined &&
							t - cursor.lastSentAt < minIntervalMs
						) {
							// Not yet due for this actor.
							continue;
						}
						let payload: DigestPayload | null;
						try {
							const since =
								cursor === undefined
									? null
									: new Date(cursor.lastSentAt);
							payload = await config.buildDigest(actorId, since);
						} catch (error) {
							onActorFailure({
								actorId,
								error,
								phase: 'buildDigest'
							});
							continue;
						}
						if (payload === null) {
							// Host signalled no content for this actor — skip
							// without bumping the cursor.
							continue;
						}
						try {
							await config.send(payload);
						} catch (error) {
							onActorFailure({
								actorId,
								error,
								phase: 'send'
							});
							continue;
						}
						processed++;
						try {
							const next: DigestCursor = {
								id: actorId,
								actorId,
								lastSentAt: t,
								lastSubject: payload.subject
							};
							if (cursor === undefined) {
								await actions.insert(table, next);
							} else {
								await actions.update(table, next);
							}
						} catch (error) {
							// The email already went out — losing the cursor
							// update means the actor may double-receive on
							// the next fire. We log so the operator sees it.
							onActorFailure({
								actorId,
								error,
								phase: 'cursor'
							});
						}
					}
				}
			})
		]
	};

	return defineSyncPack(pack);
};
