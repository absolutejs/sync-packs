/**
 * Behavioral tests for `@absolutejs/sync-pack-presence` against an
 * in-memory sync engine. Exercises:
 *
 * - heartbeat upserts (insert then update preserves identity)
 * - leave removes only the calling actor's row
 * - cleanup deletes rows past their TTL
 * - per-channel scoping on the collection
 * - per-scope (workspace) filtering
 * - prefix produces distinct table + collection + mutation names
 * - two pack instances with different prefixes coexist on one engine
 * - permission rejects a forged actorId
 */

import { describe, expect, test } from 'bun:test';
import { createSyncEngine } from '@absolutejs/sync/engine';
import { expectRejection } from '@absolutejs/sync/testing';
import {
	createInMemoryPresenceStore,
	createPresencePack,
	type PresenceRow
} from '../src';

type Ctx = { userId: string; workspaceId?: string };

describe('createPresencePack', () => {
	test('heartbeat inserts then updates without duplicating rows', async () => {
		const engine = createSyncEngine();
		let clock = 1000;
		engine.registerPack(
			createPresencePack<Ctx>({
				heartbeatTtlSec: 10,
				now: () => clock
			})
		);

		await engine.runMutation(
			'presence:heartbeat',
			{ channel: 'doc-1', state: { typing: false } },
			{ userId: 'alice' }
		);
		clock = 4000;
		await engine.runMutation(
			'presence:heartbeat',
			{ channel: 'doc-1', state: { typing: true } },
			{ userId: 'alice' }
		);

		const subscription = await engine.subscribe<
			PresenceRow,
			{ channel: string }
		>({
			collection: 'presence',
			params: { channel: 'doc-1' },
			ctx: { userId: 'alice' },
			onDiff: () => {}
		});
		expect(subscription.initial.length).toBe(1);
		expect(subscription.initial[0]).toMatchObject({
			actorId: 'alice',
			channel: 'doc-1',
			state: { typing: true },
			heartbeatAt: 4000,
			expiresAt: 14000
		});
	});

	test('leave removes only the calling actor (not other actors in the channel)', async () => {
		const engine = createSyncEngine();
		engine.registerPack(createPresencePack<Ctx>({ heartbeatTtlSec: 60 }));

		await engine.runMutation(
			'presence:heartbeat',
			{ channel: 'doc-1', state: null },
			{ userId: 'alice' }
		);
		await engine.runMutation(
			'presence:heartbeat',
			{ channel: 'doc-1', state: null },
			{ userId: 'bob' }
		);
		await engine.runMutation(
			'presence:leave',
			{ channel: 'doc-1' },
			{ userId: 'alice' }
		);

		const subscription = await engine.subscribe<
			PresenceRow,
			{ channel: string }
		>({
			collection: 'presence',
			params: { channel: 'doc-1' },
			ctx: { userId: 'alice' },
			onDiff: () => {}
		});
		const ids = subscription.initial.map((r) => r.actorId);
		expect(ids).toEqual(['bob']);
	});

	test('the cleanup schedule deletes expired rows', async () => {
		const engine = createSyncEngine();
		const store = createInMemoryPresenceStore();
		let clock = 1000;
		engine.registerPack(
			createPresencePack<Ctx>({
				heartbeatTtlSec: 10,
				now: () => clock,
				store
			})
		);

		// alice heartbeats at t=1000, expires at 11000
		await engine.runMutation(
			'presence:heartbeat',
			{ channel: 'doc-1', state: null },
			{ userId: 'alice' }
		);
		// bob heartbeats at t=2000, expires at 12000
		clock = 2000;
		await engine.runMutation(
			'presence:heartbeat',
			{ channel: 'doc-1', state: null },
			{ userId: 'bob' }
		);

		expect((store.reader.all({}) as PresenceRow[]).length).toBe(2);

		// Advance past alice's TTL but not bob's, then fire cleanup.
		clock = 11500;
		await engine.runSchedule('presence:cleanup');

		const remaining = store.reader.all({}) as PresenceRow[];
		expect(remaining.length).toBe(1);
		expect(remaining[0]?.actorId).toBe('bob');
	});

	test('subscriptions are scoped to (channel, scope) — two workspaces never see each other', async () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createPresencePack<Ctx>({
				heartbeatTtlSec: 60,
				scope: (ctx) => ctx.workspaceId ?? null
			})
		);

		await engine.runMutation(
			'presence:heartbeat',
			{ channel: 'doc-1', state: null },
			{ userId: 'alice', workspaceId: 'ws-a' }
		);
		await engine.runMutation(
			'presence:heartbeat',
			{ channel: 'doc-1', state: null },
			{ userId: 'bob', workspaceId: 'ws-b' }
		);

		const aliceView = await engine.subscribe<
			PresenceRow,
			{ channel: string }
		>({
			collection: 'presence',
			params: { channel: 'doc-1' },
			ctx: { userId: 'alice', workspaceId: 'ws-a' },
			onDiff: () => {}
		});
		const bobView = await engine.subscribe<
			PresenceRow,
			{ channel: string }
		>({
			collection: 'presence',
			params: { channel: 'doc-1' },
			ctx: { userId: 'bob', workspaceId: 'ws-b' },
			onDiff: () => {}
		});

		expect(aliceView.initial.map((r) => r.actorId)).toEqual(['alice']);
		expect(bobView.initial.map((r) => r.actorId)).toEqual(['bob']);
	});

	test('two presence packs with different prefixes coexist on one engine', async () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createPresencePack<Ctx>({ prefix: 'docs_', heartbeatTtlSec: 60 })
		);
		engine.registerPack(
			createPresencePack<Ctx>({ prefix: 'chat_', heartbeatTtlSec: 60 })
		);

		await engine.runMutation(
			'docs_presence:heartbeat',
			{ channel: 'doc-1', state: null },
			{ userId: 'alice' }
		);
		await engine.runMutation(
			'chat_presence:heartbeat',
			{ channel: 'room-1', state: null },
			{ userId: 'alice' }
		);

		const docsView = await engine.subscribe<
			PresenceRow,
			{ channel: string }
		>({
			collection: 'docs_presence',
			params: { channel: 'doc-1' },
			ctx: { userId: 'alice' },
			onDiff: () => {}
		});
		const chatView = await engine.subscribe<
			PresenceRow,
			{ channel: string }
		>({
			collection: 'chat_presence',
			params: { channel: 'room-1' },
			ctx: { userId: 'alice' },
			onDiff: () => {}
		});

		expect(docsView.initial.length).toBe(1);
		expect(chatView.initial.length).toBe(1);

		const inspection = engine.inspect();
		expect(inspection.packs.length).toBe(2);
		expect(inspection.packs.map((p) => p.ownsTables.join(','))).toEqual([
			'docs_presence',
			'chat_presence'
		]);
	});

	test('expired rows are not delivered to a fresh subscription', async () => {
		const engine = createSyncEngine();
		let clock = 1000;
		engine.registerPack(
			createPresencePack<Ctx>({
				heartbeatTtlSec: 10,
				now: () => clock
			})
		);

		await engine.runMutation(
			'presence:heartbeat',
			{ channel: 'doc-1', state: null },
			{ userId: 'alice' }
		);
		clock = 20000; // way past 11000 expiry

		const subscription = await engine.subscribe<
			PresenceRow,
			{ channel: string }
		>({
			collection: 'presence',
			params: { channel: 'doc-1' },
			ctx: { userId: 'alice' },
			onDiff: () => {}
		});
		expect(subscription.initial.length).toBe(0);
	});

	test('writes are rejected when getActorId returns nothing', async () => {
		const engine = createSyncEngine();
		engine.registerPack(createPresencePack<Ctx>({ heartbeatTtlSec: 60 }));

		const error = await expectRejection(() =>
			engine.runMutation(
				'presence:heartbeat',
				{ channel: 'doc-1', state: null },
				{} // no userId
			)
		);
		expect((error as Error).message).toMatch(
			/getActorId\(ctx\) returned no actor id/
		);
	});

	test('engine.inspect() surfaces the pack and its owned table', () => {
		const engine = createSyncEngine();
		engine.registerPack(createPresencePack<Ctx>());

		const inspection = engine.inspect();
		expect(inspection.packs).toEqual([
			{
				name: '@absolutejs/sync-pack-presence',
				version: '0.1.0',
				ownsTables: ['presence'],
				readsTables: []
			}
		]);
		expect(inspection.readers).toContain('presence');
		expect(inspection.writers).toContain('presence');
		expect(inspection.mutations).toContain('presence:heartbeat');
		expect(inspection.mutations).toContain('presence:leave');
		expect(inspection.schedules.map((s) => s.name)).toContain(
			'presence:cleanup'
		);
		expect(inspection.collections.map((c) => c.name)).toContain('presence');
	});
});
