/**
 * Behavioral tests for `@absolutejs/sync-pack-digest` against an in-memory
 * sync engine. Drives the schedule via `engine.runSchedule(...)` so the
 * tests don't depend on cron firing.
 *
 * Covers:
 * - First fire iterates actors, calls buildDigest + send, creates cursors
 * - Second fire skips actors whose cursor is fresher than minHours
 * - buildDigest returning null is a silent skip (no cursor written)
 * - A send throw on one actor doesn't block the rest; onActorFailure fires
 * - maxActorsPerFire caps the iteration; the rest wait for the next fire
 * - Cursor read collection is scoped per actor
 * - Prefix produces a distinct table/collection/schedule
 * - inspect() surfaces the pack
 */

import { describe, expect, test } from 'bun:test';
import { createSyncEngine } from '@absolutejs/sync/engine';
import {
	createDigestPack,
	createInMemoryDigestStore,
	type DigestCursor,
	type DigestPayload
} from '../src';

type Ctx = { userId?: string };

const collectingSend = () => {
	const sent: DigestPayload[] = [];
	return {
		sent,
		send: async (msg: DigestPayload) => {
			sent.push(msg);
		}
	};
};

const constBuilder = (subject: string) =>
	async (actorId: string): Promise<DigestPayload | null> => ({
		body: `digest for ${actorId}`,
		subject,
		to: `${actorId}@example.com`
	});

describe('createDigestPack', () => {
	test('first fire iterates actors, sends, and writes cursors', async () => {
		const engine = createSyncEngine();
		const store = createInMemoryDigestStore();
		const { send, sent } = collectingSend();

		engine.registerPack(
			createDigestPack<Ctx>({
				buildDigest: constBuilder('first'),
				listActors: () => ['alice', 'bob', 'carol'],
				now: () => 10_000,
				send,
				store
			})
		);

		await engine.runSchedule('digest:fire');

		expect(sent.map((m) => m.to)).toEqual([
			'alice@example.com',
			'bob@example.com',
			'carol@example.com'
		]);
		const cursors = store.reader.all({}) as DigestCursor[];
		expect(cursors.length).toBe(3);
		expect(cursors[0]).toMatchObject({
			actorId: 'alice',
			id: 'alice',
			lastSentAt: 10_000,
			lastSubject: 'first'
		});
	});

	test('second fire within minHoursBetweenDigests skips already-sent actors', async () => {
		const engine = createSyncEngine();
		const { send, sent } = collectingSend();
		let clock = 10_000;

		engine.registerPack(
			createDigestPack<Ctx>({
				buildDigest: constBuilder('weekly'),
				listActors: () => ['alice', 'bob'],
				minHoursBetweenDigests: 168,
				now: () => clock,
				send
			})
		);

		await engine.runSchedule('digest:fire');
		expect(sent.length).toBe(2);

		// 5 hours later — still well within the 168h window.
		clock = 10_000 + 5 * 60 * 60 * 1000;
		await engine.runSchedule('digest:fire');
		expect(sent.length).toBe(2); // unchanged
	});

	test('second fire after minHoursBetweenDigests sends again', async () => {
		const engine = createSyncEngine();
		const { send, sent } = collectingSend();
		let clock = 10_000;

		engine.registerPack(
			createDigestPack<Ctx>({
				buildDigest: constBuilder('weekly'),
				listActors: () => ['alice'],
				minHoursBetweenDigests: 1,
				now: () => clock,
				send
			})
		);

		await engine.runSchedule('digest:fire');
		expect(sent.length).toBe(1);

		// 2 hours later — past the 1h gap.
		clock = 10_000 + 2 * 60 * 60 * 1000;
		await engine.runSchedule('digest:fire');
		expect(sent.length).toBe(2);
	});

	test('buildDigest returning null is a silent skip — no cursor written', async () => {
		const engine = createSyncEngine();
		const store = createInMemoryDigestStore();
		const { send, sent } = collectingSend();

		engine.registerPack(
			createDigestPack<Ctx>({
				buildDigest: async (actorId) =>
					actorId === 'alice'
						? null
						: {
							body: 'b',
							subject: 's',
							to: `${actorId}@x.com`
						},
				listActors: () => ['alice', 'bob'],
				send,
				store
			})
		);

		await engine.runSchedule('digest:fire');
		expect(sent.map((m) => m.to)).toEqual(['bob@x.com']);
		const cursors = store.reader.all({}) as DigestCursor[];
		expect(cursors.map((c) => c.actorId)).toEqual(['bob']);
	});

	test('one bad send does not block the rest; onActorFailure is called', async () => {
		const engine = createSyncEngine();
		const failures: { actorId: string; phase: string }[] = [];
		const sent: DigestPayload[] = [];

		engine.registerPack(
			createDigestPack<Ctx>({
				buildDigest: constBuilder('s'),
				listActors: () => ['alice', 'bob', 'carol'],
				onActorFailure: ({ actorId, phase }) => {
					failures.push({ actorId, phase });
				},
				send: async (msg) => {
					if (msg.to === 'bob@example.com') {
						throw new Error('smtp down');
					}
					sent.push(msg);
				}
			})
		);

		await engine.runSchedule('digest:fire');

		expect(sent.map((m) => m.to)).toEqual([
			'alice@example.com',
			'carol@example.com'
		]);
		expect(failures).toEqual([{ actorId: 'bob', phase: 'send' }]);
	});

	test('maxActorsPerFire caps the iteration', async () => {
		const engine = createSyncEngine();
		const { send, sent } = collectingSend();

		engine.registerPack(
			createDigestPack<Ctx>({
				buildDigest: constBuilder('s'),
				listActors: () => ['a', 'b', 'c', 'd', 'e'],
				maxActorsPerFire: 2,
				send
			})
		);

		await engine.runSchedule('digest:fire');
		expect(sent.length).toBe(2);
	});

	test('cursor collection is scoped per actor', async () => {
		const engine = createSyncEngine();
		const { send } = collectingSend();

		engine.registerPack(
			createDigestPack<Ctx>({
				buildDigest: constBuilder('s'),
				listActors: () => ['alice', 'bob'],
				send
			})
		);

		await engine.runSchedule('digest:fire');

		const aliceView = await engine.subscribe<DigestCursor>({
			collection: 'digest_cursors',
			ctx: { userId: 'alice' },
			onDiff: () => {},
			params: undefined
		});
		const bobView = await engine.subscribe<DigestCursor>({
			collection: 'digest_cursors',
			ctx: { userId: 'bob' },
			onDiff: () => {},
			params: undefined
		});

		expect(aliceView.initial.map((c) => c.actorId)).toEqual(['alice']);
		expect(bobView.initial.map((c) => c.actorId)).toEqual(['bob']);
	});

	test('prefix produces distinct table/collection/schedule names', () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createDigestPack<Ctx>({
				buildDigest: constBuilder('s'),
				listActors: () => [],
				prefix: 'team_',
				send: async () => {}
			})
		);

		const inspection = engine.inspect();
		expect(inspection.packs[0]?.ownsTables).toEqual([
			'team_digest_cursors'
		]);
		expect(inspection.schedules.map((s) => s.name)).toContain(
			'team_digest:fire'
		);
		expect(inspection.collections.map((c) => c.name)).toContain(
			'team_digest_cursors'
		);
	});

	test('engine.inspect() surfaces the pack with default names', () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createDigestPack<Ctx>({
				buildDigest: constBuilder('s'),
				listActors: () => [],
				send: async () => {}
			})
		);

		const inspection = engine.inspect();
		expect(inspection.packs).toEqual([
			{
				name: '@absolutejs/sync-pack-digest',
				ownsTables: ['digest_cursors'],
				readsTables: [],
				version: '0.1.0'
			}
		]);
		expect(inspection.readers).toContain('digest_cursors');
		expect(inspection.writers).toContain('digest_cursors');
		expect(inspection.schedules.map((s) => s.name)).toContain(
			'digest:fire'
		);
		expect(inspection.collections.map((c) => c.name)).toContain(
			'digest_cursors'
		);
	});

	test('the schedule passes the retry policy through to defineSchedule', async () => {
		const engine = createSyncEngine();
		let attempts = 0;

		engine.registerPack(
			createDigestPack<Ctx>({
				buildDigest: constBuilder('s'),
				listActors: () => {
					attempts++;
					throw Object.assign(new Error('flaky'), { code: '40001' });
				},
				retry: { backoff: () => 0, maxAttempts: 3 },
				send: async () => {}
			})
		);

		await engine
			.runSchedule('digest:fire')
			.then(() => false)
			.catch(() => true);
		// The schedule retried up to maxAttempts.
		expect(attempts).toBe(3);
	});
});
