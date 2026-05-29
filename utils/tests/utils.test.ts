import { describe, expect, test } from 'bun:test';
import { UnauthorizedError } from '@absolutejs/sync/engine';
import { expectRejection } from '@absolutejs/sync/testing';
import {
	createInMemoryStore,
	defaultGetActorId,
	requireOwnerOrModerator,
	requireRowOwner,
	resolveActor
} from '../src';

type Ctx = { userId?: string; isModerator?: boolean };
type Note = { id: string; actorId: string; title: string };

describe('defaultGetActorId', () => {
	test("reads ctx.userId", () => {
		const fn = defaultGetActorId<Ctx>();
		expect(fn({ userId: 'alice' })).toBe('alice');
		expect(fn({})).toBeUndefined();
	});
});

describe('resolveActor', () => {
	test('returns the actor id when getActorId yields one', () => {
		const fn = defaultGetActorId<Ctx>();
		expect(resolveActor(fn, { userId: 'alice' }, 'test')).toBe('alice');
	});

	test('throws UnauthorizedError with the context label when no actor', async () => {
		const fn = defaultGetActorId<Ctx>();
		const error = await expectRejection(() => {
			resolveActor(fn, {}, 'mypack:do');
			return Promise.resolve();
		});
		expect(error).toBeInstanceOf(UnauthorizedError);
		expect((error as Error).message).toMatch(/mypack:do/);
	});
});

describe('requireRowOwner', () => {
	const rule = requireRowOwner<Ctx>(defaultGetActorId<Ctx>(), 'actorId');

	test('accepts when row.actorId matches caller', () => {
		expect(
			rule({ userId: 'alice' }, { actorId: 'alice', id: 'n1' } as Note)
		).toBe(true);
	});

	test('rejects when row.actorId is different', () => {
		expect(
			rule({ userId: 'alice' }, { actorId: 'bob', id: 'n1' } as Note)
		).toBe(false);
	});

	test('rejects when caller has no actor id', () => {
		expect(
			rule({}, { actorId: 'alice', id: 'n1' } as Note)
		).toBe(false);
	});

	test('custom actorIdField (e.g. authorId for comments)', () => {
		const commentRule = requireRowOwner<Ctx>(
			defaultGetActorId<Ctx>(),
			'authorId'
		);
		expect(
			commentRule(
				{ userId: 'alice' },
				{ authorId: 'alice', id: 'c1' } as unknown
			)
		).toBe(true);
		expect(
			commentRule(
				{ userId: 'alice' },
				{ authorId: 'bob', id: 'c1' } as unknown
			)
		).toBe(false);
	});
});

describe('requireOwnerOrModerator', () => {
	test('accepts the owner', () => {
		const store = createInMemoryStore<Note>();
		store.writer.insert(
			{ actorId: 'alice', id: 'n1', title: 'a' },
			{} as never,
			{} as never
		);
		const rule = requireOwnerOrModerator<Ctx>({
			canModerate: (ctx) => ctx.isModerator === true,
			getActorId: defaultGetActorId<Ctx>(),
			store
		});
		expect(
			rule({ userId: 'alice' }, { actorId: 'alice', id: 'n1' })
		).toBe(true);
	});

	test('rejects non-owner non-moderator', () => {
		const store = createInMemoryStore<Note>();
		const rule = requireOwnerOrModerator<Ctx>({
			canModerate: (ctx) => ctx.isModerator === true,
			getActorId: defaultGetActorId<Ctx>(),
			store
		});
		expect(
			rule({ userId: 'bob' }, { actorId: 'alice', id: 'n1' })
		).toBe(false);
	});

	test('accepts a moderator even if not the owner', () => {
		const store = createInMemoryStore<Note>();
		const rule = requireOwnerOrModerator<Ctx>({
			canModerate: (ctx) => ctx.isModerator === true,
			getActorId: defaultGetActorId<Ctx>(),
			store
		});
		expect(
			rule(
				{ isModerator: true, userId: 'mod' },
				{ actorId: 'alice', id: 'n1' }
			)
		).toBe(true);
	});

	test('falls back to store lookup when only the id is supplied', () => {
		const store = createInMemoryStore<Note>();
		store.writer.insert(
			{ actorId: 'alice', id: 'n1', title: 'a' },
			{} as never,
			{} as never
		);
		const rule = requireOwnerOrModerator<Ctx>({
			getActorId: defaultGetActorId<Ctx>(),
			store
		});
		// Subject has only { id }, no actorId — rule looks up the row.
		expect(rule({ userId: 'alice' }, { id: 'n1' })).toBe(true);
		expect(rule({ userId: 'bob' }, { id: 'n1' })).toBe(false);
	});

	test('rejects when canModerate is omitted and caller is not the owner', () => {
		const store = createInMemoryStore<Note>();
		store.writer.insert(
			{ actorId: 'alice', id: 'n1', title: 'a' },
			{} as never,
			{} as never
		);
		const rule = requireOwnerOrModerator<Ctx>({
			getActorId: defaultGetActorId<Ctx>(),
			store
		});
		expect(
			rule(
				{ isModerator: true, userId: 'mod' },
				{ actorId: 'alice', id: 'n1' }
			)
		).toBe(false);
	});
});

describe('createInMemoryStore', () => {
	test('insert + getById round-trip', () => {
		const store = createInMemoryStore<Note>();
		const row = store.writer.insert(
			{ actorId: 'alice', id: 'n1', title: 'a' },
			{} as never,
			{} as never
		) as Note;
		expect(row).toEqual({ actorId: 'alice', id: 'n1', title: 'a' });
		expect(store.getById('n1')).toEqual(row);
	});

	test('update merges by id', () => {
		const store = createInMemoryStore<Note>();
		store.writer.insert(
			{ actorId: 'alice', id: 'n1', title: 'before' },
			{} as never,
			{} as never
		);
		const updated = store.writer.update(
			{ id: 'n1', title: 'after' } as Note,
			{} as never,
			{} as never
		) as Note;
		expect(updated.title).toBe('after');
		expect(updated.actorId).toBe('alice');
	});

	test('delete removes by id', () => {
		const store = createInMemoryStore<Note>();
		store.writer.insert(
			{ actorId: 'alice', id: 'n1', title: 'a' },
			{} as never,
			{} as never
		);
		store.writer.delete({ id: 'n1' }, {} as never, {} as never);
		expect(store.getById('n1')).toBeUndefined();
	});

	test('reader.all returns all rows', () => {
		const store = createInMemoryStore<Note>();
		store.writer.insert(
			{ actorId: 'alice', id: 'n1', title: 'a' },
			{} as never,
			{} as never
		);
		store.writer.insert(
			{ actorId: 'bob', id: 'n2', title: 'b' },
			{} as never,
			{} as never
		);
		expect((store.reader.all({}) as Note[]).length).toBe(2);
	});

	test('two stores are isolated (different Maps)', () => {
		const a = createInMemoryStore<Note>();
		const b = createInMemoryStore<Note>();
		a.writer.insert(
			{ actorId: 'alice', id: 'n1', title: 'a' },
			{} as never,
			{} as never
		);
		expect(a.getById('n1')).toBeDefined();
		expect(b.getById('n1')).toBeUndefined();
	});
});
