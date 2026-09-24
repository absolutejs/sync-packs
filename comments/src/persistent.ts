import {
  defineSyncPack,
  defineCollection,
  defineMutation,
  UnauthorizedError,
  type SyncPack,
} from "@absolutejs/sync/engine";

export type CommentLink = { label: string; url: string };
export type PersistentComment = {
  id: string;
  resourceId: string;
  authorId: string;
  body: string;
  mentions: string[];
  links: CommentLink[];
  createdAt: number;
};
export type CommentDraft = {
  resourceId: string;
  body: string;
  mentions?: string[];
  links?: CommentLink[];
};
type Awaitable<T> = T | Promise<T>;
export type PersistentCommentsConfig<Ctx, Tx = unknown> = {
  /** The same name as the persistent table, so revision sources invalidate it. */
  table: string;
  /** Permission changes must invalidate existing subscribers too. */
  dependencies?: string[];
  getActorId: (ctx: Ctx) => Awaitable<string | undefined>;
  canReadResource: (id: string, ctx: Ctx) => Awaitable<boolean>;
  canWriteResource: (id: string, ctx: Ctx) => Awaitable<boolean>;
  canMention: (
    actorId: string,
    resourceId: string,
    ctx: Ctx,
  ) => Awaitable<boolean>;
  store: {
    list: (resourceId: string, ctx: Ctx) => Awaitable<PersistentComment[]>;
    /** Use the supplied engine transaction, including any audit or outbox writes. */
    insert: (
      row: PersistentComment,
      ctx: Ctx,
      tx: Tx,
    ) => Awaitable<PersistentComment>;
  };
};
export function validateCommentDraft(value: unknown): Required<CommentDraft> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid comment");
  const data = value as CommentDraft;
  if (
    Object.keys(data).some(
      (k) => !["resourceId", "body", "mentions", "links"].includes(k),
    ) ||
    typeof data.resourceId !== "string" ||
    !data.resourceId ||
    data.resourceId.length > 200 ||
    typeof data.body !== "string" ||
    data.body.length > 10000
  )
    throw Error("Invalid comment");
  const mentions = data.mentions ?? [],
    links = data.links ?? [];
  if (
    !Array.isArray(mentions) ||
    mentions.length > 50 ||
    mentions.some((m) => typeof m !== "string" || !m || m.length > 500) ||
    !Array.isArray(links) ||
    links.length > 10
  )
    throw Error("Invalid comment metadata");
  const safeLinks = links.map((link) => {
    if (
      !link ||
      typeof link.label !== "string" ||
      link.label.length > 200 ||
      typeof link.url !== "string" ||
      link.url.length > 2000 ||
      Object.keys(link).some((k) => !["label", "url"].includes(k))
    )
      throw Error("Invalid comment link");
    let url: URL;
    try {
      url = new URL(link.url);
    } catch {
      throw Error("Invalid comment link");
    }
    if (url.protocol !== "https:" || url.username || url.password)
      throw Error("Invalid comment link: use an HTTPS URL without credentials");
    return { label: link.label.trim() || url.hostname, url: url.href };
  });
  if (!data.body.trim() && !safeLinks.length)
    throw Error("Invalid comment: enter text or a supporting link");
  return {
    resourceId: data.resourceId,
    body: data.body.trim(),
    mentions: [...new Set(mentions)],
    links: safeLinks,
  };
}
/** Append-only, persistent collaboration stream. Async ACLs are checked before
 * receipt replay and again at the writer boundary. Actor and time are trusted. */
export function createPersistentCommentsPack<Ctx, Tx = unknown>(
  config: PersistentCommentsConfig<Ctx, Tx>,
): SyncPack {
  const { table } = config;
  const allowed = async (id: string, ctx: Ctx) =>
    !!(await config.getActorId(ctx)) &&
    (await config.canReadResource(id, ctx)) &&
    (await config.canWriteResource(id, ctx));
  return defineSyncPack({
    name: "@absolutejs/sync-pack-comments/persistent",
    version: "0.7.0",
    ownsTables: [table],
    readsTables: config.dependencies ?? [],
    writers: {
      [table]: {
        insert: async (value: PersistentComment, raw: unknown, tx: unknown) => {
          const ctx = raw as Ctx;
          if (
            !(await allowed(value.resourceId, ctx)) ||
            value.authorId !== (await config.getActorId(ctx))
          )
            throw new UnauthorizedError("comment write");
          const draft = validateCommentDraft({
            resourceId: value.resourceId,
            body: value.body,
            mentions: value.mentions,
            links: value.links,
          });
          for (const actor of draft.mentions)
            if (!(await config.canMention(actor, draft.resourceId, ctx)))
              throw Error(
                "Invalid comment mention: recipient must have resource access",
              );
          return config.store.insert({ ...value, ...draft }, ctx, tx as Tx);
        },
        update: () => {
          throw Error("Comment streams are append-only");
        },
        delete: () => {
          throw Error("Comment streams are append-only");
        },
      },
    },
    collections: [
      defineCollection<PersistentComment, { resourceId: string }, Ctx>({
        name: table,
        tables: [table, ...(config.dependencies ?? [])],
        key: (row) => row.id,
        authorize: async (params, ctx) =>
          typeof params?.resourceId === "string" &&
          (await config.canReadResource(params.resourceId, ctx)),
        hydrate: async (params, ctx) =>
          (await config.canReadResource(params.resourceId, ctx))
            ? (await config.store.list(params.resourceId, ctx)).filter(
                (row) => row.resourceId === params.resourceId,
              )
            : [],
      }),
    ],
    mutations: [
      defineMutation<CommentDraft, Ctx, PersistentComment>({
        name: table + ":create",
        authorize: async (args, ctx) =>
          typeof args?.resourceId === "string" &&
          (await allowed(args.resourceId, ctx)),
        handler: async (args, ctx, actions) => {
          const draft = validateCommentDraft(args);
          const authorId = await config.getActorId(ctx);
          if (!authorId || !(await allowed(draft.resourceId, ctx)))
            throw new UnauthorizedError("comment write");
          return (await actions.insert(table, {
            ...draft,
            id: crypto.randomUUID(),
            authorId,
            createdAt: Date.now(),
          })) as PersistentComment;
        },
      }),
    ],
  });
}
