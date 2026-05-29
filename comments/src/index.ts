/**
 * `@absolutejs/sync-pack-comments` — threaded comments on host-side resources
 * as a sync pack.
 *
 * Owns a single `comments` table. Per-resource read access is gated through
 * host-injected `canReadResource(resourceId, ctx)`. Edits are author-only;
 * deletes are author or moderator. Optional `bodyCrdt` config wires the
 * body field through `registerCrdt` for conflict-free editing. Optional
 * `joinUsers` config registers a `comments-with-author` join collection
 * that pairs each comment with the host's user row.
 *
 * @example
 * ```ts
 * import { createSyncEngine } from '@absolutejs/sync/engine';
 * import { createCommentsPack } from '@absolutejs/sync-pack-comments';
 *
 * const engine = createSyncEngine();
 * engine.registerPack(createCommentsPack({
 *   getActorId: (ctx) => ctx.session.userId,
 *   canReadResource: (resourceId, ctx) =>
 *     hostAcl.canRead(resourceId, ctx.session.userId),
 *   maxDepth: 8,
 * }));
 * ```
 */

import {
	createTextIndex,
	defineCollection,
	defineJoinCollection,
	defineMutation,
	defineSchema,
	defineSearchCollection,
	defineSyncPack,
	field,
	UnauthorizedError,
	type CollectionContext,
	type CrdtMergeable,
	type SyncPack,
	type TableReader,
	type TableWriter
} from '@absolutejs/sync/engine';

/** A comment row stored in the pack's owned table. */
export type CommentRow = {
	id: string;
	resourceId: string;
	/** Null on top-level comments, the parent's id on replies. */
	parentCommentId: string | null;
	authorId: string;
	body: string;
	/** Depth in the thread (0 for top-level, parent.depth + 1 for replies). */
	depth: number;
	createdAt: number;
	/** Null until the comment is edited; otherwise the timestamp of the most
	 * recent edit. */
	editedAt: number | null;
};

/** Storage adapter the pack uses for the comments table. */
export type CommentsStore = {
	reader: TableReader<CollectionContext>;
	writer: TableWriter<CommentRow, CollectionContext, unknown>;
	/** Lookup by row id; used by edit + delete mutations to verify ownership
	 * and by create to walk the parent chain for depth math. */
	getById: (id: string) => CommentRow | undefined;
};

/** Default in-memory store. Each pack instance creates its own. */
export const createInMemoryCommentsStore = (): CommentsStore => {
	const rows = new Map<string, CommentRow>();
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
				const merged = { ...(prior ?? {}), ...data } as CommentRow;
				rows.set(data.id, merged);
				return merged;
			}
		}
	};
};

/** Thrown when a reply would exceed the configured `maxDepth`. */
export class CommentDepthExceededError extends Error {
	readonly maxDepth: number;
	readonly attemptedDepth: number;
	constructor(maxDepth: number, attemptedDepth: number) {
		super(
			`Comment reply rejected: depth ${attemptedDepth} exceeds maxDepth ${maxDepth}`
		);
		this.name = 'CommentDepthExceededError';
		this.maxDepth = maxDepth;
		this.attemptedDepth = attemptedDepth;
	}
}

/** Thrown when the requested parent comment doesn't exist or doesn't match. */
export class CommentParentMismatchError extends Error {
	readonly parentCommentId: string;
	constructor(parentCommentId: string) {
		super(
			`Parent comment ${parentCommentId} not found, or its resourceId doesn't match the reply's resourceId`
		);
		this.name = 'CommentParentMismatchError';
		this.parentCommentId = parentCommentId;
	}
}

/** Factory config. `canReadResource` is the only required field. */
export type CommentsPackConfig<
	Ctx = CollectionContext,
	AuthorRow = unknown
> = {
	/**
	 * Prefix applied to the owned table name AND every collection/mutation
	 * the pack exposes. Default `""`. Use a non-empty prefix when
	 * registering multiple comments packs on one engine (e.g. one per
	 * product surface).
	 */
	prefix?: string;
	/**
	 * Extract the current actor id from the app's ctx. Default:
	 * `(ctx) => ctx.userId`. **This is the only contract the pack assumes
	 * about the app's ctx**, alongside `canReadResource` / `canModerate`.
	 */
	getActorId?: (ctx: Ctx) => string | undefined;
	/**
	 * Gate read access on a resource. The host knows which resources a
	 * given ctx can read — the pack does NOT duplicate the host's ACL.
	 * Required: pack reads return zero rows otherwise.
	 */
	canReadResource: (resourceId: string, ctx: Ctx) => boolean;
	/**
	 * Optional moderation predicate. Used by `comments:delete` — author OR
	 * moderator can delete. Default `() => false` (only authors delete).
	 */
	canModerate?: (ctx: Ctx) => boolean;
	/**
	 * Maximum thread depth (top-level = 0, first reply = 1, ...). Replies
	 * past this depth reject with {@link CommentDepthExceededError}.
	 * Default `8`.
	 */
	maxDepth?: number;
	/**
	 * When provided, register the comment row's `body` field as a CRDT via
	 * `engine.registerCrdt`. The engine then merges concurrent edits
	 * instead of overwriting. Typically `yjsText` from
	 * `@absolutejs/sync-yjs` — the pack does NOT import Yjs; the host
	 * provides the mergeable.
	 */
	bodyCrdt?: CrdtMergeable<unknown>;
	/**
	 * Override the storage adapter. Default: a per-instance in-memory
	 * store. Pass your own for a persistent backend (Drizzle, Postgres,
	 * Redis, ...).
	 */
	store?: CommentsStore;
	/** Wall-clock function. Default `Date.now`. */
	now?: () => number;
	/**
	 * Generate a fresh row id. Default `crypto.randomUUID()`. Override for
	 * deterministic ids in tests, or to route through your existing id
	 * scheme.
	 */
	newId?: () => string;
	/**
	 * When set, the pack additionally registers a `comments-with-author`
	 * join collection. The host's user table must have a registered
	 * reader/writer (so user-row changes propagate into the join). The
	 * pack itself does NOT own the users table; it only `readsTables`
	 * the configured name.
	 */
	joinUsers?: JoinUsersConfig<Ctx, AuthorRow>;
	/**
	 * When set, register a `comments-search` full-text search collection
	 * over the body field. The subscription's `params` is the query string;
	 * results are the ranked top-K, re-ranked live as comments are added,
	 * edited, or removed. Per-row read permission (which routes through
	 * `canReadResource`) still filters hits per caller.
	 */
	search?: { topK?: number };
	/**
	 * When set, register a `comment_reactions` table + matching collection
	 * + react / unreact / toggleReaction mutations. Each row is one
	 * actor's reaction with a single emoji on a single comment, deterministic
	 * id `${commentId}:${actorId}:${emoji}` for idempotent toggling.
	 */
	reactions?: ReactionsConfig;
};

/** Config for the optional reactions surface. */
export type ReactionsConfig = {
	/**
	 * Allowed emojis. Setting this filters react mutations — anything
	 * outside the list is rejected. Empty array (default) means any
	 * single-character or grapheme string is accepted.
	 */
	allowedEmojis?: string[];
	/**
	 * Custom row id generator for reaction rows. Default
	 * `(commentId, actorId, emoji) => \`${commentId}:${actorId}:${emoji}\``.
	 */
	newId?: (
		commentId: string,
		actorId: string,
		emoji: string
	) => string;
};

/** A reaction row — one per (comment, actor, emoji). */
export type CommentReactionRow = {
	id: string;
	commentId: string;
	actorId: string;
	emoji: string;
	createdAt: number;
};

/** Thrown when a react mutation supplies an emoji outside `allowedEmojis`. */
export class CommentReactionNotAllowedError extends Error {
	readonly emoji: string;
	constructor(emoji: string) {
		super(
			`Comment reaction "${emoji}" is not in the configured allowedEmojis`
		);
		this.name = 'CommentReactionNotAllowedError';
		this.emoji = emoji;
	}
}

/**
 * Config for the optional `comments-with-author` join collection.
 *
 * The pack does not own the host's user table. The host supplies the
 * right-side hydrate (typically reading from its registered reader) and
 * the join key. The engine maintains the join incrementally — changes to
 * either side fan in through `engine.applyChange`.
 */
export type JoinUsersConfig<Ctx, AuthorRow = unknown> = {
	/**
	 * The host's user table name. Surfaced in `readsTables` so the
	 * dependency graph is reviewable. Default `"users"`.
	 */
	table?: string;
	/**
	 * Get the user's id (the join field). Default `(user) => user.id`.
	 */
	key?: (user: AuthorRow) => string;
	/**
	 * Host-side hydrate for the users side of the join. The pack passes
	 * the subscription params + ctx; this returns the candidate users.
	 * Returning all users (small set) or just the authors referenced by
	 * the comments are both fine — the engine inner-joins on `authorId
	 * === id` after hydrate.
	 */
	hydrate: (
		params: { resourceId: string },
		ctx: Ctx
	) => Iterable<AuthorRow> | Promise<Iterable<AuthorRow>>;
};

/** A joined row emitted by the `comments-with-author` collection. */
export type CommentWithAuthor<AuthorRow = unknown> = CommentRow & {
	author: AuthorRow;
};

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_USER_TABLE = 'users';

const resolveActor = (
	getActorId: NonNullable<CommentsPackConfig['getActorId']>,
	ctx: unknown
): string => {
	const actorId = getActorId(ctx as CollectionContext);
	if (actorId === undefined || actorId === '') {
		throw new UnauthorizedError('comments mutation (no actor id)');
	}
	return actorId;
};

/**
 * Build a {@link SyncPack} that exposes threaded comments. Each call returns
 * a fresh pack with its own store (unless a custom `store` is supplied).
 *
 * The `AuthorRow` generic is only consulted by the
 * `comments-with-author` join collection (when `joinUsers` is set); pass
 * it to recover types for the joined output. With no `joinUsers`, default
 * `unknown` is fine.
 */
export const createCommentsPack = <
	Ctx = CollectionContext,
	AuthorRow = unknown
>(
	config: CommentsPackConfig<Ctx, AuthorRow>
): SyncPack => {
	const prefix = config.prefix ?? '';
	const table = `${prefix}comments`;
	const collectionName = table;
	const createMutationName = `${prefix}comments:create`;
	const editMutationName = `${prefix}comments:edit`;
	const deleteMutationName = `${prefix}comments:delete`;
	const maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH;
	const store = config.store ?? createInMemoryCommentsStore();
	const now = config.now ?? Date.now;
	const newId =
		config.newId ?? (() => globalThis.crypto.randomUUID());
	const getActorId = (config.getActorId ??
		((ctx: CollectionContext) =>
			(ctx as { userId?: string }).userId)) as (
		ctx: CollectionContext
	) => string | undefined;
	const canReadResource = config.canReadResource as (
		resourceId: string,
		ctx: CollectionContext
	) => boolean;
	const canModerate = (config.canModerate ?? (() => false)) as (
		ctx: CollectionContext
	) => boolean;

	type Params = { resourceId: string };

	const joinUsers = config.joinUsers;
	const userTable = joinUsers?.table ?? DEFAULT_USER_TABLE;
	const joinCollectionName = `${prefix}comments-with-author`;
	const userKey = (joinUsers?.key ?? ((row: unknown) =>
		(row as { id: string }).id)) as (user: unknown) => string;
	const search = config.search;
	const searchCollectionName = `${prefix}comments-search`;
	const searchTopK = search?.topK ?? 20;
	const reactionsConfig = config.reactions;
	const reactionsTable = `${prefix}comment_reactions`;
	const reactionsCollectionName = reactionsTable;
	const reactMutationName = `${prefix}comments:react`;
	const unreactMutationName = `${prefix}comments:unreact`;
	const toggleReactionMutationName = `${prefix}comments:toggleReaction`;
	const reactionId =
		reactionsConfig?.newId ??
		((commentId: string, actorId: string, emoji: string) =>
			`${commentId}:${actorId}:${emoji}`);
	const reactionStore = new Map<string, CommentReactionRow>();
	const reactionReader: TableReader<CollectionContext> = {
		all: () => [...reactionStore.values()]
	};
	const reactionWriter: TableWriter<
		CommentReactionRow,
		CollectionContext,
		unknown
	> = {
		delete: (row) => {
			reactionStore.delete((row as { id: string }).id);
		},
		insert: (data) => {
			reactionStore.set(data.id, data);
			return data;
		},
		update: (data) => {
			reactionStore.set(data.id, data);
			return data;
		}
	};

	const pack: SyncPack = {
		name: '@absolutejs/sync-pack-comments',
		ownsTables:
			reactionsConfig === undefined ? [table] : [table, reactionsTable],
		readsTables: joinUsers === undefined ? [] : [userTable],
		version: '0.4.0',

		schemas: defineSchema({
			[table]: {
				fields: {
					id: field.string,
					resourceId: field.string,
					parentCommentId: (value) =>
						value === null || typeof value === 'string',
					authorId: field.string,
					body: field.string,
					depth: field.number,
					createdAt: field.number,
					editedAt: (value) =>
						value === null || typeof value === 'number'
				}
			}
		}),

		readers: { [table]: store.reader },
		writers: { [table]: store.writer },

		permissions: {
			[table]: {
				read: (ctx: unknown, row: CommentRow) =>
					canReadResource(row.resourceId, ctx as CollectionContext),
				// The pack's own create handler stamps `authorId` from the
				// resolved actor, so this check passes inside the pack.
				// A host-side `actions.insert("comments", { ... })` that
				// tried to forge an `authorId` would be rejected here.
				insert: (ctx: unknown, row: CommentRow) => {
					const callerId = getActorId(ctx as CollectionContext);
					return callerId !== undefined && row.authorId === callerId;
				},
				// Edits: author only. Same row-level check as insert.
				update: (ctx: unknown, row: CommentRow) => {
					const callerId = getActorId(ctx as CollectionContext);
					return callerId !== undefined && row.authorId === callerId;
				},
				// Deletes: author OR moderator. `actions.delete` may pass
				// the full row or just the key; if `authorId` isn't in the
				// supplied subject we look it up from the store.
				delete: (ctx: unknown, row: CommentRow) => {
					const callerId = getActorId(ctx as CollectionContext);
					if (callerId === undefined) return false;
					const authorId =
						(row as { authorId?: string }).authorId ??
						(() => {
							const id = (row as { id?: string }).id;
							return id === undefined
								? undefined
								: store.getById(id)?.authorId;
						})();
					if (authorId === undefined) return false;
					if (authorId === callerId) return true;
					return canModerate(ctx as CollectionContext);
				}
			}
		},

		collections: [
			defineCollection<CommentRow, Params, CollectionContext>({
				name: collectionName,
				tables: [table],
				key: (row) => row.id,
				hydrate: (params, ctx) =>
					(store.reader.all(ctx) as CommentRow[]).filter(
						(row) =>
							row.resourceId === params.resourceId &&
							canReadResource(row.resourceId, ctx)
					),
				match: (row, params, ctx) =>
					row.resourceId === params.resourceId &&
					canReadResource(row.resourceId, ctx),
				authorize: (params, ctx) =>
					canReadResource(params.resourceId, ctx)
			})
		],

		mutations: [
			defineMutation<
				{
					resourceId: string;
					body: string;
					parentCommentId?: string | null;
				},
				CollectionContext,
				CommentRow
			>({
				name: createMutationName,
				handler: async (args, ctx, actions) => {
					if (!canReadResource(args.resourceId, ctx)) {
						throw new UnauthorizedError(
							`comments:create on resource "${args.resourceId}"`
						);
					}
					const actorId = resolveActor(getActorId, ctx);
					let depth = 0;
					if (
						args.parentCommentId !== undefined &&
						args.parentCommentId !== null
					) {
						const parent = store.getById(args.parentCommentId);
						if (
							parent === undefined ||
							parent.resourceId !== args.resourceId
						) {
							throw new CommentParentMismatchError(
								args.parentCommentId
							);
						}
						depth = parent.depth + 1;
						if (depth > maxDepth) {
							throw new CommentDepthExceededError(
								maxDepth,
								depth
							);
						}
					}
					const row: CommentRow = {
						id: newId(),
						resourceId: args.resourceId,
						parentCommentId: args.parentCommentId ?? null,
						authorId: actorId,
						body: args.body,
						depth,
						createdAt: now(),
						editedAt: null
					};
					return (await actions.insert(table, row)) as CommentRow;
				}
			}),
			defineMutation<
				{ commentId: string; body: string },
				CollectionContext,
				CommentRow
			>({
				name: editMutationName,
				handler: async (args, ctx, actions) => {
					const actorId = resolveActor(getActorId, ctx);
					const existing = store.getById(args.commentId);
					if (existing === undefined) {
						throw new UnauthorizedError(
							`comments:edit on missing comment "${args.commentId}"`
						);
					}
					if (existing.authorId !== actorId) {
						throw new UnauthorizedError(
							`comments:edit on "${args.commentId}" (not author)`
						);
					}
					const updated: CommentRow = {
						...existing,
						body: args.body,
						editedAt: now()
					};
					return (await actions.update(table, updated)) as CommentRow;
				}
			}),
			defineMutation<{ commentId: string }, CollectionContext, void>({
				name: deleteMutationName,
				handler: async (args, ctx, actions) => {
					const actorId = resolveActor(getActorId, ctx);
					const existing = store.getById(args.commentId);
					if (existing === undefined) {
						throw new UnauthorizedError(
							`comments:delete on missing comment "${args.commentId}"`
						);
					}
					const isAuthor = existing.authorId === actorId;
					const isModerator = canModerate(ctx);
					if (!isAuthor && !isModerator) {
						throw new UnauthorizedError(
							`comments:delete on "${args.commentId}" (not author, not moderator)`
						);
					}
					await actions.delete(table, { id: args.commentId });
				}
			})
		]
	};

	if (config.bodyCrdt !== undefined) {
		pack.crdt = { [table]: { body: config.bodyCrdt } };
	}

	if (search !== undefined) {
		pack.searchCollections = [
			defineSearchCollection<CommentRow>({
				name: searchCollectionName,
				table,
				index: () =>
					createTextIndex<CommentRow>({
						fields: ['body'],
						key: (row) => row.id
					}),
				key: (row) => row.id,
				limit: searchTopK,
				source: () =>
					store.reader.all({}) as Iterable<CommentRow>
			})
		];
	}

	if (joinUsers !== undefined) {
		const usersHydrate = joinUsers.hydrate;
		pack.joinCollections = [
			defineJoinCollection<
				CommentRow,
				unknown,
				CommentWithAuthor,
				Params,
				CollectionContext
			>({
				name: joinCollectionName,
				key: (out) => out.id,
				left: {
					table,
					hydrate: (params, ctx) =>
						(store.reader.all(ctx) as CommentRow[]).filter(
							(row) =>
								row.resourceId === params.resourceId &&
								canReadResource(row.resourceId, ctx)
						),
					key: (row) => row.id,
					on: (row) => row.authorId,
					// Per-resource read gate, also applied to incoming changes.
					match: (row, params, ctx) =>
						row.resourceId === params.resourceId &&
						canReadResource(row.resourceId, ctx)
				},
				right: {
					table: userTable,
					hydrate: (params, ctx) =>
						usersHydrate(params, ctx as Ctx) as Iterable<unknown>,
					key: (user) => userKey(user),
					on: (user) => userKey(user)
				},
				select: (comment, author) => ({ ...comment, author }),
				authorize: (params, ctx) =>
					canReadResource(params.resourceId, ctx)
			})
		];
	}

	if (reactionsConfig !== undefined) {
		const allowed = reactionsConfig.allowedEmojis;
		const isAllowed = (emoji: string): boolean =>
			allowed === undefined || allowed.length === 0
				? true
				: allowed.includes(emoji);

		pack.schemas = {
			...(pack.schemas ?? {}),
			[reactionsTable]: {
				fields: {
					actorId: field.string,
					commentId: field.string,
					createdAt: field.number,
					emoji: field.string,
					id: field.string
				}
			}
		};
		pack.readers = {
			...(pack.readers ?? {}),
			[reactionsTable]: reactionReader
		};
		pack.writers = {
			...(pack.writers ?? {}),
			[reactionsTable]: reactionWriter
		};
		pack.permissions = {
			...(pack.permissions ?? {}),
			[reactionsTable]: {
				// Reactions are visible to anyone who can read the comment's
				// resource. We look the comment up to gate on canReadResource.
				read: (ctx: unknown, row: CommentReactionRow) => {
					const comment = store.getById(row.commentId);
					if (comment === undefined) return false;
					return canReadResource(
						comment.resourceId,
						ctx as CollectionContext
					);
				},
				// Per-row writes: the row's actorId must match the caller.
				insert: (ctx: unknown, row: CommentReactionRow) => {
					const callerId = getActorId(ctx as CollectionContext);
					return callerId !== undefined && row.actorId === callerId;
				},
				update: (ctx: unknown, row: CommentReactionRow) => {
					const callerId = getActorId(ctx as CollectionContext);
					return callerId !== undefined && row.actorId === callerId;
				},
				delete: (ctx: unknown, row: CommentReactionRow) => {
					const callerId = getActorId(ctx as CollectionContext);
					if (callerId === undefined) return false;
					if (
						(row as { actorId?: string }).actorId !== undefined
					) {
						return (row as { actorId: string }).actorId === callerId;
					}
					const id = (row as { id?: string }).id;
					if (id === undefined) return false;
					return reactionStore.get(id)?.actorId === callerId;
				}
			}
		};

		pack.collections = [
			...(pack.collections ?? []),
			defineCollection<
				CommentReactionRow,
				{ commentId: string },
				CollectionContext
			>({
				name: reactionsCollectionName,
				tables: [reactionsTable],
				key: (row) => row.id,
				hydrate: (params, ctx) => {
					const comment = store.getById(params.commentId);
					if (
						comment === undefined ||
						!canReadResource(comment.resourceId, ctx)
					) {
						return [];
					}
					return (
						reactionReader.all(ctx) as CommentReactionRow[]
					).filter((row) => row.commentId === params.commentId);
				},
				match: (row, params, ctx) => {
					if (row.commentId !== params.commentId) return false;
					const comment = store.getById(params.commentId);
					return (
						comment !== undefined &&
						canReadResource(comment.resourceId, ctx)
					);
				},
				authorize: (params, ctx) => {
					const comment = store.getById(params.commentId);
					return (
						comment !== undefined &&
						canReadResource(comment.resourceId, ctx)
					);
				}
			})
		];

		pack.mutations = [
			...(pack.mutations ?? []),
			defineMutation<
				{ commentId: string; emoji: string },
				CollectionContext,
				CommentReactionRow
			>({
				name: reactMutationName,
				handler: async (args, ctx, actions) => {
					if (!isAllowed(args.emoji)) {
						throw new CommentReactionNotAllowedError(args.emoji);
					}
					const actorId = resolveActor(getActorId, ctx);
					const comment = store.getById(args.commentId);
					if (comment === undefined) {
						throw new UnauthorizedError(
							`comments:react on missing comment "${args.commentId}"`
						);
					}
					if (!canReadResource(comment.resourceId, ctx)) {
						throw new UnauthorizedError(
							`comments:react on comment "${args.commentId}" (no read access)`
						);
					}
					const id = reactionId(args.commentId, actorId, args.emoji);
					const existing = reactionStore.get(id);
					if (existing !== undefined) return existing;
					const row: CommentReactionRow = {
						actorId,
						commentId: args.commentId,
						createdAt: now(),
						emoji: args.emoji,
						id
					};
					return (await actions.insert(
						reactionsTable,
						row
					)) as CommentReactionRow;
				}
			}),
			defineMutation<
				{ commentId: string; emoji: string },
				CollectionContext,
				void
			>({
				name: unreactMutationName,
				handler: async (args, ctx, actions) => {
					const actorId = resolveActor(getActorId, ctx);
					const id = reactionId(args.commentId, actorId, args.emoji);
					if (reactionStore.get(id) === undefined) return;
					await actions.delete(reactionsTable, { id });
				}
			}),
			defineMutation<
				{ commentId: string; emoji: string },
				CollectionContext,
				{ reacted: boolean }
			>({
				name: toggleReactionMutationName,
				handler: async (args, ctx, actions) => {
					if (!isAllowed(args.emoji)) {
						throw new CommentReactionNotAllowedError(args.emoji);
					}
					const actorId = resolveActor(getActorId, ctx);
					const comment = store.getById(args.commentId);
					if (comment === undefined) {
						throw new UnauthorizedError(
							`comments:toggleReaction on missing comment "${args.commentId}"`
						);
					}
					if (!canReadResource(comment.resourceId, ctx)) {
						throw new UnauthorizedError(
							`comments:toggleReaction on comment "${args.commentId}" (no read access)`
						);
					}
					const id = reactionId(args.commentId, actorId, args.emoji);
					const existing = reactionStore.get(id);
					if (existing === undefined) {
						const row: CommentReactionRow = {
							actorId,
							commentId: args.commentId,
							createdAt: now(),
							emoji: args.emoji,
							id
						};
						await actions.insert(reactionsTable, row);
						return { reacted: true };
					}
					await actions.delete(reactionsTable, { id });
					return { reacted: false };
				}
			})
		];
	}

	return defineSyncPack(pack);
};
