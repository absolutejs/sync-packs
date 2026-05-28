/**
 * Behavioral tests for `@absolutejs/sync-pack-comments` against an in-memory
 * sync engine. Covers the pack's contract end-to-end:
 *
 * - `canReadResource` gates the create mutation AND the read collection
 * - thread depth is enforced (depth + parent.depth check)
 * - parent-resource mismatch is rejected
 * - edit is author-only
 * - delete is author OR moderator (when canModerate returns true)
 * - bodyCrdt registers the body as a CRDT field
 * - prefix produces distinct table + mutation names
 * - inspect() surfaces the pack
 */

import { describe, expect, test } from 'bun:test';
import { createSyncEngine } from '@absolutejs/sync/engine';
import {
	CommentDepthExceededError,
	CommentParentMismatchError,
	createCommentsPack,
	createInMemoryCommentsStore,
	type CommentRow
} from '../src';

type Ctx = { userId?: string; isModerator?: boolean };

const rejection = async (fn: () => unknown): Promise<unknown> => {
	try {
		await fn();
	} catch (error) {
		return error;
	}
	throw new Error('expected throw');
};

// A predictable ID generator so test rows are easy to point at.
const newIdFactory = () => {
	let n = 0;
	return () => `c${++n}`;
};

describe('createCommentsPack', () => {
	test('create + read happy path: comment appears in the resource\'s collection', async () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createCommentsPack<Ctx>({
				canReadResource: () => true,
				getActorId: (ctx) => ctx.userId,
				newId: newIdFactory(),
				now: () => 1_000
			})
		);

		const inserted = (await engine.runMutation(
			'comments:create',
			{ body: 'first', resourceId: 'doc-1' },
			{ userId: 'alice' }
		)) as CommentRow;

		expect(inserted).toMatchObject({
			authorId: 'alice',
			body: 'first',
			createdAt: 1_000,
			depth: 0,
			editedAt: null,
			id: 'c1',
			parentCommentId: null,
			resourceId: 'doc-1'
		});

		const subscription = await engine.subscribe<
			CommentRow,
			{ resourceId: string }
		>({
			collection: 'comments',
			ctx: { userId: 'bob' },
			onDiff: () => {},
			params: { resourceId: 'doc-1' }
		});
		expect(subscription.initial.length).toBe(1);
		expect(subscription.initial[0]?.id).toBe('c1');
	});

	test('canReadResource gates create and authorize', async () => {
		const engine = createSyncEngine();
		const canRead = (resourceId: string, ctx: Ctx) =>
			resourceId === 'public' || ctx.userId === 'alice';
		engine.registerPack(
			createCommentsPack<Ctx>({
				canReadResource: canRead,
				getActorId: (ctx) => ctx.userId,
				newId: newIdFactory()
			})
		);

		// Alice can post on a private resource (canRead returns true for her).
		await engine.runMutation(
			'comments:create',
			{ body: 'alice-only', resourceId: 'private' },
			{ userId: 'alice' }
		);

		// Bob cannot post on the same private resource.
		const error = await rejection(() =>
			engine.runMutation(
				'comments:create',
				{ body: 'bob-attempt', resourceId: 'private' },
				{ userId: 'bob' }
			)
		);
		expect((error as Error).message).toMatch(
			/comments:create on resource "private"/
		);

		// Bob also can't subscribe to the private resource's collection.
		const subscribeError = await rejection(() =>
			engine.subscribe<CommentRow, { resourceId: string }>({
				collection: 'comments',
				ctx: { userId: 'bob' },
				onDiff: () => {},
				params: { resourceId: 'private' }
			})
		);
		expect((subscribeError as Error).message).toMatch(/Not authorized/);
	});

	test('replies attach to a parent and depth increments', async () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createCommentsPack<Ctx>({
				canReadResource: () => true,
				getActorId: (ctx) => ctx.userId,
				newId: newIdFactory()
			})
		);

		const root = (await engine.runMutation(
			'comments:create',
			{ body: 'root', resourceId: 'doc' },
			{ userId: 'alice' }
		)) as CommentRow;
		const reply = (await engine.runMutation(
			'comments:create',
			{ body: 'reply', parentCommentId: root.id, resourceId: 'doc' },
			{ userId: 'bob' }
		)) as CommentRow;

		expect(reply.parentCommentId).toBe(root.id);
		expect(reply.depth).toBe(1);
	});

	test('maxDepth is enforced', async () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createCommentsPack<Ctx>({
				canReadResource: () => true,
				getActorId: (ctx) => ctx.userId,
				maxDepth: 2,
				newId: newIdFactory()
			})
		);

		const root = (await engine.runMutation(
			'comments:create',
			{ body: 'root', resourceId: 'doc' },
			{ userId: 'a' }
		)) as CommentRow;
		const reply1 = (await engine.runMutation(
			'comments:create',
			{ body: 'reply 1', parentCommentId: root.id, resourceId: 'doc' },
			{ userId: 'b' }
		)) as CommentRow;
		const reply2 = (await engine.runMutation(
			'comments:create',
			{ body: 'reply 2', parentCommentId: reply1.id, resourceId: 'doc' },
			{ userId: 'c' }
		)) as CommentRow;
		expect(reply2.depth).toBe(2);

		// A fourth-level reply (depth 3) should fail (max is 2).
		const error = await rejection(() =>
			engine.runMutation(
				'comments:create',
				{
					body: 'too deep',
					parentCommentId: reply2.id,
					resourceId: 'doc'
				},
				{ userId: 'd' }
			)
		);
		expect(error).toBeInstanceOf(CommentDepthExceededError);
		expect((error as CommentDepthExceededError).attemptedDepth).toBe(3);
	});

	test('parent-resource mismatch is rejected', async () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createCommentsPack<Ctx>({
				canReadResource: () => true,
				getActorId: (ctx) => ctx.userId,
				newId: newIdFactory()
			})
		);

		const onDocA = (await engine.runMutation(
			'comments:create',
			{ body: 'doc-a-root', resourceId: 'doc-a' },
			{ userId: 'alice' }
		)) as CommentRow;

		const error = await rejection(() =>
			engine.runMutation(
				'comments:create',
				{
					body: 'cross-resource reply',
					parentCommentId: onDocA.id,
					resourceId: 'doc-b'
				},
				{ userId: 'bob' }
			)
		);
		expect(error).toBeInstanceOf(CommentParentMismatchError);
	});

	test('edit is author-only', async () => {
		const engine = createSyncEngine();
		let clock = 100;
		engine.registerPack(
			createCommentsPack<Ctx>({
				canReadResource: () => true,
				getActorId: (ctx) => ctx.userId,
				newId: newIdFactory(),
				now: () => clock
			})
		);

		const created = (await engine.runMutation(
			'comments:create',
			{ body: 'original', resourceId: 'doc' },
			{ userId: 'alice' }
		)) as CommentRow;
		expect(created.editedAt).toBeNull();

		// Non-author can't edit.
		const error = await rejection(() =>
			engine.runMutation(
				'comments:edit',
				{ body: 'hijacked', commentId: created.id },
				{ userId: 'bob' }
			)
		);
		expect((error as Error).message).toMatch(/not author/);

		// Author can edit; editedAt is stamped.
		clock = 250;
		const edited = (await engine.runMutation(
			'comments:edit',
			{ body: 'corrected', commentId: created.id },
			{ userId: 'alice' }
		)) as CommentRow;
		expect(edited.body).toBe('corrected');
		expect(edited.editedAt).toBe(250);
	});

	test('delete is author OR moderator', async () => {
		const engine = createSyncEngine();
		const store = createInMemoryCommentsStore();
		engine.registerPack(
			createCommentsPack<Ctx>({
				canModerate: (ctx) => ctx.isModerator === true,
				canReadResource: () => true,
				getActorId: (ctx) => ctx.userId,
				newId: newIdFactory(),
				store
			})
		);

		const alice1 = (await engine.runMutation(
			'comments:create',
			{ body: 'alice 1', resourceId: 'doc' },
			{ userId: 'alice' }
		)) as CommentRow;
		const alice2 = (await engine.runMutation(
			'comments:create',
			{ body: 'alice 2', resourceId: 'doc' },
			{ userId: 'alice' }
		)) as CommentRow;
		const bob = (await engine.runMutation(
			'comments:create',
			{ body: 'bob', resourceId: 'doc' },
			{ userId: 'bob' }
		)) as CommentRow;

		// Bob can delete his own.
		await engine.runMutation(
			'comments:delete',
			{ commentId: bob.id },
			{ userId: 'bob' }
		);
		// Alice can delete her own.
		await engine.runMutation(
			'comments:delete',
			{ commentId: alice1.id },
			{ userId: 'alice' }
		);
		// Random user can't delete alice's other comment.
		const refused = await rejection(() =>
			engine.runMutation(
				'comments:delete',
				{ commentId: alice2.id },
				{ userId: 'eve' }
			)
		);
		expect((refused as Error).message).toMatch(
			/not author, not moderator/
		);
		// But the moderator can.
		await engine.runMutation(
			'comments:delete',
			{ commentId: alice2.id },
			{ isModerator: true, userId: 'mod' }
		);
		expect(store.reader.all({})).toEqual([]);
	});

	test('bodyCrdt wires the body field through registerCrdt', () => {
		const engine = createSyncEngine();
		const stubCrdt = {
			empty: () => '',
			merge: (a: unknown) => a,
			isEmpty: () => true
		};
		engine.registerPack(
			createCommentsPack<Ctx>({
				bodyCrdt: stubCrdt as never,
				canReadResource: () => true,
				getActorId: (ctx) => ctx.userId
			})
		);

		// The auto-generated "comments:merge" mutation is registered by the
		// engine when registerCrdt is called — so its presence is the
		// signal that the CRDT registration fired.
		const mutationNames = engine.inspect().mutations;
		expect(mutationNames).toContain('comments:merge');
	});

	test('prefix produces distinct table + mutation names', () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createCommentsPack<Ctx>({
				canReadResource: () => true,
				getActorId: (ctx) => ctx.userId,
				prefix: 'docs_'
			})
		);
		engine.registerPack(
			createCommentsPack<Ctx>({
				canReadResource: () => true,
				getActorId: (ctx) => ctx.userId,
				prefix: 'chat_'
			})
		);

		const inspection = engine.inspect();
		expect(inspection.packs.map((p) => p.ownsTables.join(','))).toEqual([
			'docs_comments',
			'chat_comments'
		]);
		expect(inspection.mutations).toContain('docs_comments:create');
		expect(inspection.mutations).toContain('chat_comments:create');
		expect(inspection.collections.map((c) => c.name)).toContain(
			'docs_comments'
		);
		expect(inspection.collections.map((c) => c.name)).toContain(
			'chat_comments'
		);
	});

	test('engine.inspect() surfaces the pack', () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createCommentsPack<Ctx>({
				canReadResource: () => true,
				getActorId: (ctx) => ctx.userId
			})
		);
		const inspection = engine.inspect();
		expect(inspection.packs).toEqual([
			{
				name: '@absolutejs/sync-pack-comments',
				ownsTables: ['comments'],
				readsTables: [],
				version: '0.1.0'
			}
		]);
		expect(inspection.readers).toContain('comments');
		expect(inspection.writers).toContain('comments');
		expect(inspection.mutations).toContain('comments:create');
		expect(inspection.mutations).toContain('comments:edit');
		expect(inspection.mutations).toContain('comments:delete');
		expect(inspection.collections.map((c) => c.name)).toContain('comments');
	});
});
