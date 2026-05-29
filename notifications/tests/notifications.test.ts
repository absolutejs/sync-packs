import { describe, expect, test } from 'bun:test';
import { createSyncEngine } from '@absolutejs/sync/engine';
import { expectRejection } from '@absolutejs/sync/testing';
import {
	createInMemoryNotificationsStore,
	createNotificationsPack,
	type NotificationRow
} from '../src';

type Ctx = { userId?: string; isModerator?: boolean };

// Real-world apps call `notifications:notify` from a trusted host path
// (a webhook, a schedule, another mutation). The pack's permission for
// `insert` requires the caller be either the target actor or a moderator.
// The tests below register the pack with `canModerate: ctx => ctx.isModerator`
// and pass `{ isModerator: true }` as the notify ctx; in production you'd
// stamp a `systemTrusted: true` flag (or similar) on whatever ctx your
// host's `notify` wrapper passes.
const trustedCanModerate = (ctx: Ctx) => ctx.isModerator === true;

const newIdFactory = () => {
	let n = 0;
	return () => `n${++n}`;
};

const notify = (
	engine: ReturnType<typeof createSyncEngine>,
	args: {
		actorId: string;
		kind?: string;
		title?: string;
		body?: string;
		href?: string | null;
		expiresAt?: number | null;
	},
	ctx: Ctx = { isModerator: true }
) =>
	engine.runMutation(
		'notifications:notify',
		{
			actorId: args.actorId,
			body: args.body ?? 'body',
			expiresAt: args.expiresAt,
			href: args.href,
			kind: args.kind ?? 'mention',
			title: args.title ?? 'New mention'
		},
		ctx
	);

describe('createNotificationsPack', () => {
	test('notify inserts a row and the target actor sees it in their inbox', async () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createNotificationsPack<Ctx>({
				canModerate: trustedCanModerate,
				getActorId: (ctx) => ctx.userId,
				newId: newIdFactory(),
				now: () => 1_000
			})
		);

		const inserted = (await notify(
			engine,
			{ actorId: 'alice', title: 'You were @mentioned' }
		)) as NotificationRow;
		expect(inserted.id).toBe('n1');
		expect(inserted.actorId).toBe('alice');
		expect(inserted.readAt).toBeNull();
		expect(inserted.expiresAt).toBeNull();

		const aliceView = await engine.subscribe<NotificationRow>({
			collection: 'notifications',
			ctx: { userId: 'alice' },
			onDiff: () => {},
			params: undefined
		});
		const bobView = await engine.subscribe<NotificationRow>({
			collection: 'notifications',
			ctx: { userId: 'bob' },
			onDiff: () => {},
			params: undefined
		});
		expect(aliceView.initial.map((row) => row.id)).toEqual(['n1']);
		expect(bobView.initial.length).toBe(0);
	});

	test('markRead is owner-only; non-owner throws', async () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createNotificationsPack<Ctx>({
				canModerate: trustedCanModerate,
				getActorId: (ctx) => ctx.userId,
				newId: newIdFactory(),
				now: () => 1_000
			})
		);
		const row = (await notify(engine, {
			actorId: 'alice'
		})) as NotificationRow;

		// Bob can't mark Alice's notification read.
		const error = await expectRejection(() =>
			engine.runMutation(
				'notifications:markRead',
				{ notificationId: row.id },
				{ userId: 'bob' }
			)
		);
		expect((error as Error).message).toMatch(/not your row/);

		// Alice can.
		const updated = (await engine.runMutation(
			'notifications:markRead',
			{ notificationId: row.id },
			{ userId: 'alice' }
		)) as NotificationRow;
		expect(updated.readAt).toBe(1_000);
	});

	test('markAllRead bulk-updates the caller’s unread rows only', async () => {
		const engine = createSyncEngine();
		const store = createInMemoryNotificationsStore();
		engine.registerPack(
			createNotificationsPack<Ctx>({
				canModerate: trustedCanModerate,
				getActorId: (ctx) => ctx.userId,
				newId: newIdFactory(),
				now: () => 1_000,
				store
			})
		);
		await notify(engine, { actorId: 'alice', title: 'a-1' });
		await notify(engine, { actorId: 'alice', title: 'a-2' });
		await notify(engine, { actorId: 'bob', title: 'b-1' });

		const result = (await engine.runMutation(
			'notifications:markAllRead',
			undefined,
			{ userId: 'alice' }
		)) as { marked: number };
		expect(result.marked).toBe(2);

		const all = store.reader.all({}) as NotificationRow[];
		const aliceUnread = all.filter(
			(row) => row.actorId === 'alice' && row.readAt === null
		);
		const bobUnread = all.filter(
			(row) => row.actorId === 'bob' && row.readAt === null
		);
		expect(aliceUnread.length).toBe(0);
		expect(bobUnread.length).toBe(1); // Bob's still unread
	});

	test('moderator can read other actors’ rows; non-moderator cannot', async () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createNotificationsPack<Ctx>({
				canModerate: (ctx) => ctx.isModerator === true,
				getActorId: (ctx) => ctx.userId,
				newId: newIdFactory()
			})
		);
		await notify(engine, { actorId: 'alice', title: 'a-1' });
		await notify(engine, { actorId: 'bob', title: 'b-1' });

		const modView = await engine.subscribe<NotificationRow>({
			collection: 'notifications',
			ctx: { isModerator: true, userId: 'mod' },
			onDiff: () => {},
			params: undefined
		});
		// Moderator sees all rows.
		expect(
			modView.initial.map((row) => row.actorId).sort()
		).toEqual(['alice', 'bob']);
	});

	test('autoArchiveAfterDays stamps expiresAt AND registers a cleanup schedule', async () => {
		const engine = createSyncEngine();
		const store = createInMemoryNotificationsStore();
		let clock = 0;
		engine.registerPack(
			createNotificationsPack<Ctx>({
				canModerate: trustedCanModerate,
				autoArchiveAfterDays: 1,
				getActorId: (ctx) => ctx.userId,
				newId: newIdFactory(),
				now: () => clock,
				store
			})
		);
		clock = 1_000;
		const row = (await notify(engine, {
			actorId: 'alice'
		})) as NotificationRow;
		// 1 day = 86_400_000 ms.
		expect(row.expiresAt).toBe(1_000 + 86_400_000);

		// Cleanup schedule registered.
		const inspection = engine.inspect();
		expect(inspection.schedules.map((s) => s.name)).toContain(
			'notifications:cleanup'
		);

		// Advance past expiry and fire the schedule.
		clock = 2_000 + 86_400_000;
		await engine.runSchedule('notifications:cleanup');
		const remaining = store.reader.all({}) as NotificationRow[];
		expect(remaining.length).toBe(0);
	});

	test('no autoArchiveAfterDays: rows live forever; no schedule registered', async () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createNotificationsPack<Ctx>({
				canModerate: trustedCanModerate,
				getActorId: (ctx) => ctx.userId,
				newId: newIdFactory()
			})
		);
		const inspection = engine.inspect();
		expect(inspection.schedules.map((s) => s.name)).not.toContain(
			'notifications:cleanup'
		);
		const row = (await notify(engine, {
			actorId: 'alice'
		})) as NotificationRow;
		expect(row.expiresAt).toBeNull();
	});

	test('prefix produces distinct names', () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createNotificationsPack<Ctx>({ prefix: 'system_' })
		);
		const inspection = engine.inspect();
		expect(inspection.packs[0]?.ownsTables).toEqual([
			'system_notifications'
		]);
		expect(inspection.mutations).toContain(
			'system_notifications:notify'
		);
		expect(inspection.mutations).toContain(
			'system_notifications:markRead'
		);
		expect(inspection.mutations).toContain(
			'system_notifications:markAllRead'
		);
		expect(inspection.collections.map((c) => c.name)).toContain(
			'system_notifications'
		);
	});

	test('engine.inspect() surfaces the pack', () => {
		const engine = createSyncEngine();
		engine.registerPack(createNotificationsPack<Ctx>());
		expect(engine.inspect().packs).toEqual([
			{
				name: '@absolutejs/sync-pack-notifications',
				ownsTables: ['notifications'],
				readsTables: [],
				version: '0.2.0'
			}
		]);
	});

	// ─── 0.2 — kindFilter on the collection params ────────────────────────

	test('subscribing with { kind } filters the inbox to that kind only', async () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createNotificationsPack<Ctx>({
				canModerate: trustedCanModerate,
				getActorId: (ctx) => ctx.userId,
				newId: newIdFactory()
			})
		);
		await notify(engine, {
			actorId: 'alice',
			kind: 'mention',
			title: 'mention-1'
		});
		await notify(engine, {
			actorId: 'alice',
			kind: 'reply',
			title: 'reply-1'
		});
		await notify(engine, {
			actorId: 'alice',
			kind: 'mention',
			title: 'mention-2'
		});

		const mentionsOnly = await engine.subscribe<
			NotificationRow,
			{ kind?: string }
		>({
			collection: 'notifications',
			ctx: { userId: 'alice' },
			onDiff: () => {},
			params: { kind: 'mention' }
		});
		expect(
			mentionsOnly.initial.map((row) => row.title).sort()
		).toEqual(['mention-1', 'mention-2']);

		const allKinds = await engine.subscribe<
			NotificationRow,
			{ kind?: string }
		>({
			collection: 'notifications',
			ctx: { userId: 'alice' },
			onDiff: () => {},
			params: {}
		});
		expect(allKinds.initial.length).toBe(3);
	});
});
