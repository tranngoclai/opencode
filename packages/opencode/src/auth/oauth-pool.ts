import { Oauth, type Info } from "./schema"

export type OAuthProviderPool = {
  type: "oauth"
  active: Record<string, string | undefined>
  order: Record<string, string[] | undefined>
  records: OAuthStoredRecord[]
}

export type RawProvider = Info | OAuthProviderPool | unknown

export type OAuthStoredRecord = {
  id: string
  namespace: string
  createdAt: number
  updatedAt: number
  access: string
  refresh: string
  expires: number
  accountId?: string
  enterpriseUrl?: string
  label?: string
  health: {
    successCount: number
    failureCount: number
    lastStatusCode?: number
    cooldownUntil?: number
    lastErrorAt?: number
  }
}

export type OAuthAccount = Omit<OAuthStoredRecord, "access" | "refresh"> & {
  active: boolean
}

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

export function listOAuthAccounts(value: RawProvider): OAuthAccount[] {
  const provider = toOAuthProviderPool(value)
  if (!provider) return []
  const active = selectRecord(provider, "default")
  return recordsForNamespace(provider, "default").map((record) => ({
    id: record.id,
    namespace: record.namespace,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expires: record.expires,
    accountId: record.accountId,
    enterpriseUrl: record.enterpriseUrl,
    label: record.label,
    health: record.health,
    active: record.id === active?.id,
  }))
}

export function removeOAuthAccount(value: RawProvider, recordID: string) {
  const provider = toOAuthProviderPool(value)
  if (!provider) return { provider: undefined, removed: false, remaining: 0 }
  const records = provider.records.filter((record) => !(record.id === recordID && record.namespace === "default"))
  const removed = records.length !== provider.records.length
  const remaining = records.filter((record) => record.namespace === "default").length
  if (!removed) return { provider, removed: false, remaining }
  if (records.length === 0) return { provider: undefined, removed: true, remaining: 0 }
  const order = normalizeOrder(
    records.filter((record) => record.namespace === "default").map((record) => record.id),
    provider.order.default ?? [],
  ).filter((id) => id !== recordID)
  return {
    provider: {
      ...provider,
      records,
      active: { ...provider.active, default: provider.active.default === recordID ? order[0] : provider.active.default },
      order: { ...provider.order, default: order },
    },
    removed: true,
    remaining,
  }
}

export function rotateOAuthAccount(value: RawProvider, input?: { cooldownUntil?: number; statusCode?: number }) {
  const provider = toOAuthProviderPool(value)
  if (!provider) return undefined
  const active = selectRecord(provider, "default")
  if (!active) return provider
  const order = normalizeOrder(
    provider.records.filter((record) => record.namespace === "default").map((record) => record.id),
    provider.order.default ?? [],
  )
  const now = Date.now()
  const records = provider.records.map((record) =>
    record.id === active.id && record.namespace === "default"
      ? {
          ...record,
          updatedAt: now,
          health: {
            ...record.health,
            failureCount: record.health.failureCount + 1,
            lastErrorAt: now,
            lastStatusCode: input?.statusCode,
            cooldownUntil: input?.cooldownUntil ?? record.health.cooldownUntil,
          },
        }
      : record,
  )
  const nextOrder = order.filter((id) => id !== active.id).concat(active.id)
  const nextActive = nextOrder.find((id) => {
    const record = records.find((item) => item.id === id && item.namespace === "default")
    return !record?.health.cooldownUntil || record.health.cooldownUntil <= now
  }) ?? nextOrder[0]
  return {
    ...provider,
    records,
    active: { ...provider.active, default: nextActive },
    order: { ...provider.order, default: nextOrder },
  }
}

function normalizeOrder(ids: string[], order: string[]) {
  return [...order.filter((id, index) => ids.includes(id) && order.indexOf(id) === index), ...ids.filter((id) => !order.includes(id))]
}

function recordsForNamespace(provider: OAuthProviderPool, namespace: string) {
  const records = provider.records.filter((record) => record.namespace === namespace)
  const order = normalizeOrder(
    records.map((record) => record.id),
    provider.order[namespace] ?? [],
  )
  return order.map((id) => records.find((record) => record.id === id)).filter((record): record is OAuthStoredRecord => record !== undefined)
}
