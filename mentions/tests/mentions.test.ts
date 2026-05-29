import { describe, expect, test } from 'bun:test';
import { createSyncEngine } from '@absolutejs/sync/engine';
import { expectRejection } from '@absolutejs/sync/testing';
import {
	createInMemoryMentionsStore,
	createMentionsPack,
	parseMentions,
	type MentionRow,
	type OnMentionArgs
} from '../src';

type Ctx = { userId?: string };

describe('parseMentions', () => {
	test('extracts distinct @usernames in body order', () => {
		expect(parseMentions('hi @alice and @bob and @alice again')).toEqual([
			{ index: 3, username: 'alice' },
			{ index: 14, username: 'bob' }
		]);
	});

	test('handles dashes, underscores, digits', () => {
		expect(parseMentions('cc @user_1 @alex-b @42')).toEqual([
			{ index: 3, username: 'user_1' },
			{ index: 11, username: 'alex-b' },
			{ index: 19, username: '42' }
		]);
	});

	test('returns empty for bodies without @', () => {
		expect(parseMentions('no mentions here')).toEqual([]);
	});
});

describe('createMentionsPack', () => {
	test('mentions:record writes one row per resolved username and skips self-mentions', async () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createMentionsPack<Ctx>({
				getActorId: (ctx) => ctx.userId,
				now: () => 1_000,
				resolveActorId: (username) =>
					username === 'alice'
						? 'user-alice'
						: username === 'bob'
							? 'user-bob'
							: undefined
			})
		);

		const written = (await engine.runMutation(
			'mentions:record',
			{
				body: 'hi @alice and @bob and @ghost — @bob again',
				sourceId: 'c-1',
				sourceKind: 'comment'
			},
			{ userId: 'user-alice' } // alice posts
		)) as MentionRow[];

		// alice is the author so her own mention is skipped; bob is recorded;
		// "ghost" resolves to undefined and is skipped.
		expect(written.length).toBe(1);
		expect(written[0]).toMatchObject({
			authorId: 'user-alice',
			id: 'comment:c-1:user-bob',
			mentionedActorId: 'user-bob',
			resolvedAt: null,
			sourceId: 'c-1',
			sourceKind: 'comment',
			username: 'bob'
		});
		expect(written[0]?.snippet).toContain('@bob');
	});

	test('mentions:record is idempotent (re-recording the same row returns the existing row)', async () => {
		const engine = createSyncEngine();
		const store = createInMemoryMentionsStore();
		let clock = 1_000;
		engine.registerPack(
			createMentionsPack<Ctx>({
				getActorId: (ctx) => ctx.userId,
				now: () => clock,
				store
			})
		);

		await engine.runMutation(
			'mentions:record',
			{
				body: '@bob hello',
				sourceId: 'c-1',
				sourceKind: 'comment'
			},
			{ userId: 'alice' }
		);
		clock = 9_999;
		const second = (await engine.runMutation(
			'mentions:record',
			{
				body: '@bob hello (edited)',
				sourceId: 'c-1',
				sourceKind: 'comment'
			},
			{ userId: 'alice' }
		)) as MentionRow[];
		// Re-record returns the prior row (createdAt unchanged) — no double-fire.
		expect(second[0]?.createdAt).toBe(1_000);
	});

	test('onMention fires once per new row with the parsed mention', async () => {
		const engine = createSyncEngine();
		const seen: OnMentionArgs[] = [];
		engine.registerPack(
			createMentionsPack<Ctx>({
				getActorId: (ctx) => ctx.userId,
				now: () => 1_000,
				onMention: (args) => {
					seen.push(args);
				}
			})
		);

		await engine.runMutation(
			'mentions:record',
			{
				body: '@bob and @carol look at this',
				sourceId: 'c-1',
				sourceKind: 'comment'
			},
			{ userId: 'alice' }
		);
		expect(seen.length).toBe(2);
		expect(seen.map((arg) => arg.mention.username)).toEqual(['bob', 'carol']);
	});

	test('onMention throwing does not roll back the recorded row', async () => {
		const engine = createSyncEngine();
		const store = createInMemoryMentionsStore();
		engine.registerPack(
			createMentionsPack<Ctx>({
				getActorId: (ctx) => ctx.userId,
				now: () => 1_000,
				onMention: () => {
					throw new Error('downstream notify failed');
				},
				store
			})
		);

		const written = (await engine.runMutation(
			'mentions:record',
			{ body: '@bob hi', sourceId: 'c-1', sourceKind: 'comment' },
			{ userId: 'alice' }
		)) as MentionRow[];
		expect(written.length).toBe(1);
		expect(store.getById(written[0]!.id)).toBeDefined();
	});

	test('mentions collection is per-actor scoped', async () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createMentionsPack<Ctx>({
				getActorId: (ctx) => ctx.userId,
				now: () => 1_000
			})
		);

		await engine.runMutation(
			'mentions:record',
			{ body: '@bob hi', sourceId: 'c-1', sourceKind: 'comment' },
			{ userId: 'alice' }
		);
		await engine.runMutation(
			'mentions:record',
			{ body: '@carol hi', sourceId: 'c-2', sourceKind: 'comment' },
			{ userId: 'alice' }
		);

		const bobView = await engine.subscribe<MentionRow, { sourceKind?: string }>(
			{
				collection: 'mentions',
				ctx: { userId: 'bob' },
				onDiff: () => {},
				params: {}
			}
		);
		expect(bobView.initial.map((row) => row.username)).toEqual(['bob']);

		const carolView = await engine.subscribe<MentionRow, { sourceKind?: string }>(
			{
				collection: 'mentions',
				ctx: { userId: 'carol' },
				onDiff: () => {},
				params: {}
			}
		);
		expect(carolView.initial.map((row) => row.username)).toEqual(['carol']);

		const eveView = await engine.subscribe<MentionRow, { sourceKind?: string }>(
			{
				collection: 'mentions',
				ctx: { userId: 'eve' },
				onDiff: () => {},
				params: {}
			}
		);
		expect(eveView.initial.length).toBe(0);
	});

	test('unresolvedOnly param filters out already-resolved rows', async () => {
		const engine = createSyncEngine();
		let clock = 1_000;
		engine.registerPack(
			createMentionsPack<Ctx>({
				getActorId: (ctx) => ctx.userId,
				now: () => clock
			})
		);
		const [written] = (await engine.runMutation(
			'mentions:record',
			{ body: '@bob ping', sourceId: 'c-1', sourceKind: 'comment' },
			{ userId: 'alice' }
		)) as MentionRow[];
		expect(written?.resolvedAt).toBeNull();

		clock = 2_000;
		await engine.runMutation(
			'mentions:resolve',
			{ id: written!.id },
			{ userId: 'bob' }
		);

		const inboxAll = await engine.subscribe<MentionRow, { unresolvedOnly?: boolean }>(
			{
				collection: 'mentions',
				ctx: { userId: 'bob' },
				onDiff: () => {},
				params: {}
			}
		);
		expect(inboxAll.initial.length).toBe(1);
		expect(inboxAll.initial[0]?.resolvedAt).toBe(2_000);

		const inboxUnresolved = await engine.subscribe<
			MentionRow,
			{ unresolvedOnly?: boolean }
		>({
			collection: 'mentions',
			ctx: { userId: 'bob' },
			onDiff: () => {},
			params: { unresolvedOnly: true }
		});
		expect(inboxUnresolved.initial.length).toBe(0);
	});

	test('mentions:resolve and mentions:dismiss reject other actors', async () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createMentionsPack<Ctx>({
				getActorId: (ctx) => ctx.userId,
				now: () => 1_000
			})
		);
		const [row] = (await engine.runMutation(
			'mentions:record',
			{ body: '@bob hi', sourceId: 'c-1', sourceKind: 'comment' },
			{ userId: 'alice' }
		)) as MentionRow[];

		await expectRejection(() =>
			engine.runMutation(
				'mentions:resolve',
				{ id: row!.id },
				{ userId: 'eve' }
			)
		);
		await expectRejection(() =>
			engine.runMutation(
				'mentions:dismiss',
				{ id: row!.id },
				{ userId: 'eve' }
			)
		);
	});

	test('composition: onMention can forward to a notifications-style sink', async () => {
		const notifications: Array<{
			targetActorId: string;
			body: string;
			href: string;
		}> = [];
		const engine = createSyncEngine();
		engine.registerPack(
			createMentionsPack<Ctx>({
				getActorId: (ctx) => ctx.userId,
				now: () => 1_000,
				onMention: ({ mention }) => {
					notifications.push({
						body: mention.snippet,
						href: `/comments/${mention.sourceId}`,
						targetActorId: mention.mentionedActorId
					});
				}
			})
		);

		await engine.runMutation(
			'mentions:record',
			{
				body: 'thoughts @bob? cc @carol',
				sourceId: 'c-7',
				sourceKind: 'comment'
			},
			{ userId: 'alice' }
		);
		expect(notifications.length).toBe(2);
		expect(notifications.map((n) => n.targetActorId).sort()).toEqual([
			'bob',
			'carol'
		]);
		expect(notifications[0]?.href).toBe('/comments/c-7');
	});

	test('engine.inspect() surfaces the pack', () => {
		const engine = createSyncEngine();
		engine.registerPack(createMentionsPack<Ctx>());
		const inspection = engine.inspect();
		expect(inspection.packs).toEqual([
			{
				name: '@absolutejs/sync-pack-mentions',
				ownsTables: ['mentions'],
				readsTables: [],
				version: '0.1.0'
			}
		]);
		expect(inspection.mutations).toContain('mentions:record');
		expect(inspection.mutations).toContain('mentions:resolve');
		expect(inspection.mutations).toContain('mentions:dismiss');
		expect(inspection.collections.map((c) => c.name)).toContain('mentions');
	});

	test('prefix produces distinct names', () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createMentionsPack<Ctx>({ prefix: 'wsA_' })
		);
		const inspection = engine.inspect();
		expect(inspection.packs[0]?.ownsTables).toEqual(['wsA_mentions']);
		expect(inspection.mutations).toContain('wsA_mentions:record');
		expect(inspection.mutations).toContain('wsA_mentions:resolve');
		expect(inspection.mutations).toContain('wsA_mentions:dismiss');
	});
});
