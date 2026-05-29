/**
 * `@absolutejs/sync-pack-mentions` — `@username` parser pack for
 * `@absolutejs/sync`. Owns a `mentions` table, exposes a
 * `mentions:record` mutation that parses a body, writes per-actor
 * mention rows, and fires an `onMention` hook the host can use to
 * compose with other packs (notifications, email, Slack, …).
 *
 * Composition model: packs never call each other's mutations directly.
 * Instead, the host wires them. This pack provides the parser + the
 * per-actor collection; the `onMention` hook is the seam — typically
 * `({ mention }, ctx, actions) => engine.runMutation('notifications:notify', …)`.
 * The pack itself only owns the mentions table.
 *
 * @example
 * ```ts
 * import { createSyncEngine } from '@absolutejs/sync/engine';
 * import { createMentionsPack } from '@absolutejs/sync-pack-mentions';
 *
 * const engine = createSyncEngine();
 * engine.registerPack(createMentionsPack({
 *   getActorId: (ctx) => ctx.session.userId,
 *   resolveActorId: async (username) => userIdByUsername(username),
 *   onMention: async ({ mention }, ctx) => {
 *     await engine.runMutation('notifications:notify', {
 *       targetActorId: mention.mentionedActorId,
 *       kind: 'mention',
 *       title: `You were mentioned`,
 *       body: mention.snippet,
 *       href: `/comments/${mention.sourceId}`,
 *     }, ctx);
 *   },
 * }));
 * ```
 */

import {
	defineCollection,
	defineMutation,
	defineSchema,
	defineSyncPack,
	field,
	UnauthorizedError,
	type CollectionContext,
	type MutationActions,
	type SyncPack,
	type TableReader,
	type TableWriter
} from '@absolutejs/sync/engine';

/** One row per `(sourceKind, sourceId, mentionedActorId)`. */
export type MentionRow = {
	/** `${sourceKind}:${sourceId}:${mentionedActorId}` — deterministic so re-recording is idempotent. */
	id: string;
	/** Host-level category for the row that originated the mention ("comment", "doc", "task", …). */
	sourceKind: string;
	/** Host-level id of the row that originated the mention. */
	sourceId: string;
	/** Who wrote the body containing the mention. `null` for system-generated content. */
	authorId: string | null;
	/** The actor id the `@username` resolved to. */
	mentionedActorId: string;
	/** The raw username text (without the `@`). */
	username: string;
	/** A short excerpt of the body around the mention — useful for inbox previews. */
	snippet: string;
	createdAt: number;
	/** Stamped by `mentions:resolve` (host's onMention hook is free to call it). */
	resolvedAt: number | null;
};

export type MentionsStore = {
	reader: TableReader<CollectionContext>;
	writer: TableWriter<MentionRow, CollectionContext, unknown>;
	getById: (id: string) => MentionRow | undefined;
};

export const createInMemoryMentionsStore = (): MentionsStore => {
	const rows = new Map<string, MentionRow>();
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
				const merged = { ...(prior ?? {}), ...data } as MentionRow;
				rows.set(data.id, merged);
				return merged;
			}
		}
	};
};

/** Default regex — matches `@word` where `word` is one or more `[A-Za-z0-9_-]`. */
export const DEFAULT_MENTION_PATTERN = /@([A-Za-z0-9_-]+)/g;
const DEFAULT_SNIPPET_RADIUS = 30;

/** Args passed to the host's `onMention` hook. */
export type OnMentionArgs = {
	mention: MentionRow;
	/** Full body the mention came from. */
	body: string;
};

export type MentionsPackConfig<Ctx = CollectionContext> = {
	prefix?: string;
	getActorId?: (ctx: Ctx) => string | undefined;
	/**
	 * Regex used to extract `@usernames` from a body. Must have the `g`
	 * flag. Default {@link DEFAULT_MENTION_PATTERN}.
	 */
	pattern?: RegExp;
	/**
	 * Resolve a matched username to the actor id to record + notify.
	 * Returning `undefined` skips that match (unknown user). Default is
	 * identity (`username -> username`), useful for tests and for apps
	 * where usernames already double as actor ids.
	 */
	resolveActorId?: (
		username: string,
		ctx: Ctx
	) => Promise<string | undefined> | string | undefined;
	/**
	 * How many characters around each match to keep in `snippet`.
	 * Default 30 each side; the snippet is clamped to the body length.
	 */
	snippetRadius?: number;
	/**
	 * Composition seam — fired once per mention after its row is
	 * written. The host's typical implementation calls
	 * `engine.runMutation('notifications:notify', …)` here. Errors are
	 * caught + logged; one failing hook does not roll back the recorded
	 * mention row.
	 */
	onMention?: (
		args: OnMentionArgs,
		ctx: Ctx,
		actions: MutationActions
	) => void | Promise<void>;
	/** Custom store. Default per-instance in-memory. */
	store?: MentionsStore;
	/** Wall-clock. Default `Date.now`. */
	now?: () => number;
};

const buildSnippet = (body: string, matchIndex: number, radius: number): string => {
	const start = Math.max(0, matchIndex - radius);
	const end = Math.min(body.length, matchIndex + radius);
	const prefix = start > 0 ? '…' : '';
	const suffix = end < body.length ? '…' : '';
	return `${prefix}${body.slice(start, end)}${suffix}`;
};

/** Extract distinct `@username` matches from a body. Public so tests can lean on it. */
export const parseMentions = (
	body: string,
	pattern: RegExp = DEFAULT_MENTION_PATTERN
): { username: string; index: number }[] => {
	const seen = new Set<string>();
	const matches: { username: string; index: number }[] = [];
	pattern.lastIndex = 0;
	let match: RegExpExecArray | null = pattern.exec(body);
	while (match !== null) {
		const username = match[1];
		if (username !== undefined && !seen.has(username)) {
			seen.add(username);
			matches.push({ index: match.index, username });
		}
		if (!pattern.global) break;
		match = pattern.exec(body);
	}
	pattern.lastIndex = 0;
	return matches;
};

const rowId = (
	sourceKind: string,
	sourceId: string,
	mentionedActorId: string
): string => `${sourceKind}:${sourceId}:${mentionedActorId}`;

/**
 * Build a {@link SyncPack} that parses `@mentions` from a posted body
 * and writes one row per mentioned actor. Composes with other packs
 * (notifications, digest, …) via the `onMention` hook — the pack itself
 * never calls another pack's mutations.
 */
export const createMentionsPack = <Ctx = CollectionContext>(
	config: MentionsPackConfig<Ctx> = {}
): SyncPack => {
	const prefix = config.prefix ?? '';
	const table = `${prefix}mentions`;
	const collectionName = table;
	const recordMutationName = `${prefix}mentions:record`;
	const resolveMutationName = `${prefix}mentions:resolve`;
	const dismissMutationName = `${prefix}mentions:dismiss`;
	const store = config.store ?? createInMemoryMentionsStore();
	const now = config.now ?? Date.now;
	const pattern = config.pattern ?? DEFAULT_MENTION_PATTERN;
	const snippetRadius = config.snippetRadius ?? DEFAULT_SNIPPET_RADIUS;
	const getActorId = (config.getActorId ??
		((ctx: CollectionContext) =>
			(ctx as { userId?: string }).userId)) as (
		ctx: CollectionContext
	) => string | undefined;
	const resolveActorId = (config.resolveActorId ??
		((username: string) => username)) as (
		username: string,
		ctx: CollectionContext
	) => Promise<string | undefined> | string | undefined;
	const onMention = config.onMention as
		| ((
				args: OnMentionArgs,
				ctx: CollectionContext,
				actions: MutationActions
		  ) => void | Promise<void>)
		| undefined;

	type Params = { sourceKind?: string; unresolvedOnly?: boolean };

	return defineSyncPack({
		name: '@absolutejs/sync-pack-mentions',
		ownsTables: [table],
		readsTables: [],
		version: '0.1.0',

		schemas: defineSchema({
			[table]: {
				fields: {
					id: field.string,
					sourceKind: field.string,
					sourceId: field.string,
					authorId: (value) =>
						value === null || typeof value === 'string',
					mentionedActorId: field.string,
					username: field.string,
					snippet: field.string,
					createdAt: field.number,
					resolvedAt: (value) =>
						value === null || typeof value === 'number'
				}
			}
		}),

		readers: { [table]: store.reader },
		writers: { [table]: store.writer },

		permissions: {
			[table]: {
				read: (ctx: unknown, row: MentionRow) => {
					const callerId = getActorId(ctx as CollectionContext);
					return callerId !== undefined && row.mentionedActorId === callerId;
				},
				// `mentions:record` is host-trusted (the record mutation
				// parses + inserts on behalf of the author). Allow any
				// insert; the recorded row's mentionedActorId comes from
				// the resolveActorId callback the host configured.
				insert: () => true,
				update: (ctx: unknown, row: MentionRow) => {
					const callerId = getActorId(ctx as CollectionContext);
					return callerId !== undefined && row.mentionedActorId === callerId;
				},
				delete: (ctx: unknown, row: MentionRow) => {
					const callerId = getActorId(ctx as CollectionContext);
					if (callerId === undefined) return false;
					const ownerId =
						(row as { mentionedActorId?: string }).mentionedActorId ??
						(() => {
							const id = (row as { id?: string }).id;
							return id === undefined
								? undefined
								: store.getById(id)?.mentionedActorId;
						})();
					return ownerId === callerId;
				}
			}
		},

		collections: [
			defineCollection<MentionRow, Params, CollectionContext>({
				name: collectionName,
				tables: [table],
				key: (row) => row.id,
				hydrate: (params, ctx) => {
					const callerId = getActorId(ctx);
					if (callerId === undefined) return [];
					return (store.reader.all(ctx) as MentionRow[]).filter(
						(row) =>
							row.mentionedActorId === callerId &&
							(params.sourceKind === undefined ||
								row.sourceKind === params.sourceKind) &&
							(params.unresolvedOnly !== true ||
								row.resolvedAt === null)
					);
				},
				match: (row, params, ctx) => {
					const callerId = getActorId(ctx);
					if (
						callerId === undefined ||
						row.mentionedActorId !== callerId
					) {
						return false;
					}
					return (
						(params.sourceKind === undefined ||
							row.sourceKind === params.sourceKind) &&
						(params.unresolvedOnly !== true || row.resolvedAt === null)
					);
				},
				authorize: (_params, ctx) =>
					getActorId(ctx as CollectionContext) !== undefined
			})
		],

		mutations: [
			// mentions:record { sourceKind, sourceId, body, authorId? } —
			// host calls this RIGHT AFTER its own post mutation succeeds.
			// The pack parses `@usernames`, resolves them to actor ids,
			// writes one mention row per actor (idempotent on re-record),
			// and fires `onMention` per row so the host can compose with
			// other packs (notifications, email, …).
			defineMutation<
				{
					sourceKind: string;
					sourceId: string;
					body: string;
					authorId?: string | null;
				},
				CollectionContext,
				MentionRow[]
			>({
				name: recordMutationName,
				handler: async (args, ctx, actions) => {
					const authorIdInput =
						args.authorId === undefined
							? getActorId(ctx as CollectionContext) ?? null
							: args.authorId;
					const matches = parseMentions(args.body, pattern);
					const written: MentionRow[] = [];
					for (const { username, index } of matches) {
						const resolved = await resolveActorId(
							username,
							ctx as CollectionContext
						);
						if (resolved === undefined) continue;
						if (
							authorIdInput !== null &&
							resolved === authorIdInput
						) {
							continue;
						}
						const id = rowId(
							args.sourceKind,
							args.sourceId,
							resolved
						);
						const existing = store.getById(id);
						if (existing !== undefined) {
							written.push(existing);
							continue;
						}
						const row: MentionRow = {
							authorId: authorIdInput,
							createdAt: now(),
							id,
							mentionedActorId: resolved,
							resolvedAt: null,
							snippet: buildSnippet(
								args.body,
								index,
								snippetRadius
							),
							sourceId: args.sourceId,
							sourceKind: args.sourceKind,
							username
						};
						const inserted = (await actions.insert(
							table,
							row
						)) as MentionRow;
						written.push(inserted);
						if (onMention !== undefined) {
							try {
								await onMention(
									{ body: args.body, mention: inserted },
									ctx as CollectionContext,
									actions as MutationActions
								);
							} catch (error) {
								console.error(
									'[sync-pack-mentions] onMention hook threw:',
									error
								);
							}
						}
					}
					return written;
				}
			}),
			defineMutation<
				{ id: string },
				CollectionContext,
				MentionRow | undefined
			>({
				name: resolveMutationName,
				handler: async (args, ctx, actions) => {
					const callerId = getActorId(ctx as CollectionContext);
					if (callerId === undefined) {
						throw new UnauthorizedError(
							'mentions:resolve (no actor id)'
						);
					}
					const existing = store.getById(args.id);
					if (existing === undefined) return undefined;
					if (existing.mentionedActorId !== callerId) {
						throw new UnauthorizedError(
							'mentions:resolve (not the mentioned actor)'
						);
					}
					if (existing.resolvedAt !== null) return existing;
					return (await actions.update(table, {
						...existing,
						resolvedAt: now()
					})) as MentionRow;
				}
			}),
			defineMutation<{ id: string }, CollectionContext, void>({
				name: dismissMutationName,
				handler: async (args, ctx, actions) => {
					const callerId = getActorId(ctx as CollectionContext);
					if (callerId === undefined) {
						throw new UnauthorizedError(
							'mentions:dismiss (no actor id)'
						);
					}
					const existing = store.getById(args.id);
					if (existing === undefined) return;
					if (existing.mentionedActorId !== callerId) {
						throw new UnauthorizedError(
							'mentions:dismiss (not the mentioned actor)'
						);
					}
					await actions.delete(table, { id: args.id });
				}
			})
		]
	});
};
