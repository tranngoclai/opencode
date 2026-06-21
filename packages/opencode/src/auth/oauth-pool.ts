import type { OAuthPoolStore, OAuthStoredRecord } from "@opencode-ai/plugin"
import { Effect, Option } from "effect"
import { Oauth, type Info } from "./schema"

export const AUTH_VERSION = 2

export type OAuthProviderPool = {
  type: "oauth"
  active: Record<string, string | undefined>
  order: Record<string, string[] | undefined>
  records: OAuthStoredRecord[]
}

export type RawProvider = Info | OAuthProviderPool | unknown

type OAuthPoolProviderStore = Parameters<OAuthPoolStore["update"]>[0] extends (store: { providers: infer Providers }) => unknown
  ? Providers
  : never

// On-disk format wraps the provider map in a `{ version, providers }` envelope.
// Legacy files store the flat provider map at the top level; accept both.
export function unwrapProviders(value: unknown): Record<string, RawProvider> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const envelope = value as { version?: unknown; providers?: unknown }
    if (envelope.providers && typeof envelope.providers === "object") {
      return envelope.providers as Record<string, RawProvider>
    }
  }
  return (value ?? {}) as Record<string, RawProvider>
}

export function activeOAuth(value: RawProvider): Oauth | undefined {
  const provider = toOAuthProviderPool(value)
  if (!provider) return undefined
  const record = selectRecord(provider, "default")
  if (!record) return undefined
  return new Oauth({
    type: "oauth",
    access: record.access,
    refresh: record.refresh ?? "",
    expires: record.expires,
    accountId: record.accountId,
    enterpriseUrl: record.enterpriseUrl,
  })
}

export function toOAuthProviderPool(value: RawProvider): OAuthProviderPool | undefined {
  if (!value || typeof value !== "object") return undefined
  if ((value as { type?: unknown }).type !== "oauth") return undefined
  if (Array.isArray((value as { records?: unknown }).records)) return value as OAuthProviderPool
  const legacy = value as Partial<Oauth>
  if (typeof legacy.access !== "string" || typeof legacy.refresh !== "string" || typeof legacy.expires !== "number") return undefined
  return {
    type: "oauth",
    active: { default: "default" },
    order: { default: ["default"] },
    records: [
      {
        id: "default",
        namespace: "default",
        createdAt: 0,
        updatedAt: 0,
        access: legacy.access,
        refresh: legacy.refresh,
        expires: legacy.expires,
        accountId: legacy.accountId,
        enterpriseUrl: legacy.enterpriseUrl,
        health: { successCount: 0, failureCount: 0 },
      },
    ],
  }
}

function selectRecord(provider: OAuthProviderPool, namespace: string) {
  const records = provider.records.filter((record) => record.namespace === namespace)
  const orderedIDs = normalizeOrder(
    records.map((record) => record.id),
    provider.order[namespace] ?? [],
  )
  const now = Date.now()
  const id = provider.active[namespace] ?? orderedIDs[0]
  const active = records.find((record) => record.id === id)
  if (active && (!active.health.cooldownUntil || active.health.cooldownUntil <= now)) return active
  return (
    orderedIDs
      .map((id) => records.find((record) => record.id === id))
      .find((record) => record && (!record.health.cooldownUntil || record.health.cooldownUntil <= now)) ??
    active ??
    records[0]
  )
}

export function updateActiveOAuthRecord(provider: OAuthProviderPool, info: Oauth): OAuthProviderPool {
  const now = Date.now()
  const active = selectRecord(provider, "default")
  const index = provider.records.findIndex((record) => {
    if (active && record.id === active.id && record.namespace === active.namespace) return true
    if (info.accountId && record.accountId === info.accountId) return true
    return record.refresh === info.refresh
  })
  if (index === -1) {
    const id = info.accountId ?? crypto.randomUUID()
    return {
      ...provider,
      active: { ...provider.active, default: id },
      order: { ...provider.order, default: [id, ...(provider.order.default ?? []).filter((item) => item !== id)] },
      records: [
        ...provider.records,
        {
          id,
          namespace: "default",
          createdAt: now,
          updatedAt: now,
          access: info.access,
          refresh: info.refresh,
          expires: info.expires,
          accountId: info.accountId,
          enterpriseUrl: info.enterpriseUrl,
          health: { successCount: 0, failureCount: 0 },
        },
      ],
    }
  }

  return {
    ...provider,
    records: provider.records.map((record, recordIndex) =>
      recordIndex === index
        ? {
            ...record,
            updatedAt: now,
            access: info.access,
            refresh: info.refresh,
            expires: info.expires,
            accountId: info.accountId,
            enterpriseUrl: info.enterpriseUrl,
          }
        : record,
    ),
  }
}

function normalizeOrder(ids: string[], order: string[]) {
  return [...order.filter((id, index) => ids.includes(id) && order.indexOf(id) === index), ...ids.filter((id) => !order.includes(id))]
}

export function createPoolStore(deps: {
  allRaw: () => Effect.Effect<Record<string, RawProvider>, unknown>
  writeRaw: (data: Record<string, RawProvider>) => Effect.Effect<void, unknown>
  decode: (value: unknown) => Option.Option<Info>
}): OAuthPoolStore {
  const { allRaw, writeRaw, decode } = deps

  // Serial queue prevents concurrent update() calls from clobbering each other (TOCTOU).
  // Effect.runPromise is safe here because allRaw/writeRaw close over already-resolved
  // service instances from the parent layer — no Effect runtime services are required.
  let updateQueue: Promise<unknown> = Promise.resolve()
  function enqueueUpdate<T>(fn: () => Promise<T>): Promise<T> {
    const next = updateQueue.then(fn, fn)
    updateQueue = next.then(() => undefined, () => undefined)
    return next
  }

  return {
    snapshot(providerID, namespace = "default") {
      return Effect.runPromise(
        Effect.gen(function* () {
          const provider = toOAuthProviderPool((yield* allRaw())[providerID])
          if (!provider) return { records: [], orderedIDs: [] }
          const records = provider.records.filter((record) => record.namespace === namespace)
          const orderedIDs = normalizeOrder(
            records.map((record) => record.id),
            provider.order[namespace] ?? [],
          )
          return {
            records: records.map((record) => ({ ...record, providerID, recordID: record.id })),
            orderedIDs,
            activeID: provider.active[namespace] ?? orderedIDs[0],
          }
        }),
      )
    },
    update(fn) {
      return enqueueUpdate(() => Effect.runPromise(
        Effect.gen(function* () {
          const raw = yield* allRaw()
          const providers: OAuthPoolProviderStore = Object.fromEntries(
            Object.entries(raw).flatMap((entry): Array<readonly [string, OAuthPoolProviderStore[string]]> => {
              const [providerID, value] = entry
              const pool = toOAuthProviderPool(value)
              if (pool) return [[providerID, pool] as const]
              const decoded = decode(value)
              if (decoded._tag === "Some" && decoded.value.type !== "oauth") return [[providerID, decoded.value] as const]
              return []
            }),
          )
          const before = Object.fromEntries(Object.entries(providers).map(([providerID, value]) => [providerID, JSON.stringify(value)]))
          const result = yield* Effect.promise(() => Promise.resolve(fn({ providers })))
          if (!result.changed) return result.value
          const next = { ...raw }
          for (const providerID of Object.keys(before)) {
            if (!(providerID in providers)) delete next[providerID]
          }
          for (const [providerID, value] of Object.entries(providers)) {
            if (before[providerID] === JSON.stringify(value)) continue
            next[providerID] = value
          }
          yield* writeRaw(next)
          return result.value
        }),
      ))
    },
    updateBestEffort(fn) {
      return this.update(fn).then(() => undefined, () => undefined)
    },
  }
}
