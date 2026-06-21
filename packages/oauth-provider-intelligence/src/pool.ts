import type { OAuthAccountContext, OAuthPoolHook, OAuthPoolStore } from "@opencode-ai/plugin"
import { displayLabel } from "./account-label.js"
import { quotaScore, usage } from "./quota.js"

// Extracts the oauth-specific variant from the store's provider union rather than
// importing a concrete type, so this package stays decoupled from the storage implementation.
type OAuthPoolProvider = Parameters<OAuthPoolStore["update"]>[0] extends (store: { providers: infer Providers }) => unknown
  ? Providers extends Record<string, infer Provider>
    ? Extract<Provider, { type: "oauth" }>
    : never
  : never

export async function upsert(
  providerID: string,
  namespace = "default",
  aliases: string[] | undefined,
  account: Parameters<NonNullable<OAuthPoolHook["upsert"]>>[0]["account"],
  store: OAuthPoolStore,
) {
  const normalized = normalizeNamespace(namespace)
  await store.update((data) => {
    const now = Date.now()
    const keys = [...new Set([providerID, ...(aliases ?? [])])]
    const provider = mergeProviders(keys.map((key) => data.providers[key]).filter((item): item is OAuthPoolProvider => item?.type === "oauth"))
    for (const key of keys) {
      if (key !== providerID) delete data.providers[key]
    }

    const record = {
      id: account.accountId ?? crypto.randomUUID(),
      namespace: normalized,
      createdAt: now,
      updatedAt: now,
      access: account.access,
      refresh: account.refresh,
      expires: account.expires,
      accountId: account.accountId,
      enterpriseUrl: account.enterpriseUrl,
      label: account.label,
      health: { successCount: 0, failureCount: 0 },
    }

    if (!provider) {
      data.providers[providerID] = {
        type: "oauth",
        active: { [normalized]: record.id },
        order: { [normalized]: [record.id] },
        records: [record],
      }
      return { value: undefined, changed: true }
    }

    data.providers[providerID] = provider
    const index = provider.records.findIndex((item) => (account.accountId ? item.accountId === account.accountId : item.refresh === account.refresh))
    const previous = index === -1 ? undefined : provider.records[index]
    const id = previous?.id ?? record.id
    const recordNamespace = previous?.namespace ?? normalized
    provider.records[index === -1 ? provider.records.length : index] = {
      ...record,
      id,
      namespace: recordNamespace,
      createdAt: previous?.createdAt ?? now,
      health: previous?.health ?? record.health,
    }
    provider.order[recordNamespace] = [id, ...(provider.order[recordNamespace] ?? []).filter((item) => item !== id)]
    provider.active[recordNamespace] = id
    return { value: undefined, changed: true }
  })
}

export async function snapshot(providerID: string, namespace = "default", store: OAuthPoolStore, configDir: string) {
  const normalized = normalizeNamespace(namespace)
  const result = await store.snapshot(providerID, normalized)
  return {
    records: await Promise.all(
      result.records.map(async (record) => ({
        id: record.id,
        providerID,
        namespace: record.namespace,
        recordID: record.recordID,
        updatedAt: record.updatedAt,
        createdAt: record.createdAt,
        accountId: record.accountId,
        enterpriseUrl: record.enterpriseUrl,
        health: record.health,
        label: await displayLabel(record, configDir),
      })),
    ),
    orderedIDs: result.orderedIDs,
    activeID: result.activeID,
  }
}

export async function list(providerID: string, namespace = "default", store: OAuthPoolStore, configDir: string) {
  return snapshot(providerID, namespace, store, configDir).then((result) => result.records)
}

export async function orderedIDs(providerID: string, namespace = "default", store: OAuthPoolStore) {
  return store.snapshot(providerID, normalizeNamespace(namespace)).then((result) => result.orderedIDs)
}

export async function moveToBack(providerID: string, namespace: string, recordID: string, store: OAuthPoolStore) {
  const normalized = normalizeNamespace(namespace)
  await store.updateBestEffort((data) => {
    const provider = data.providers[providerID]
    if (!provider || provider.type !== "oauth") return { value: undefined, changed: false }
    if (!provider.records.some((record) => record.id === recordID && record.namespace === normalized)) {
      return { value: undefined, changed: false }
    }
    const order = recordIDsForNamespace(provider, normalized)
    provider.order[normalized] = order.filter((id) => id !== recordID).concat(recordID)
    provider.active[normalized] = provider.order[normalized]?.[0] ?? provider.active[normalized]
    return { value: undefined, changed: true }
  })
}

export async function recordOutcome(input: Parameters<NonNullable<OAuthPoolHook["recordOutcome"]>>[0]) {
  const namespace = normalizeNamespace(input.namespace)
  await input.store.updateBestEffort((data) => {
    const provider = data.providers[input.providerID]
    if (!provider || provider.type !== "oauth") return { value: undefined, changed: false }
    const record = provider.records.find((item) => item.id === input.recordID && item.namespace === namespace)
    if (!record) return { value: undefined, changed: false }

    const now = Date.now()
    const prevCooldown = record.health.cooldownUntil && record.health.cooldownUntil > now ? record.health.cooldownUntil : undefined
    record.health = {
      ...record.health,
      cooldownUntil: input.ok ? undefined : (input.cooldownUntil ?? prevCooldown),
      lastStatusCode: input.statusCode,
      lastErrorAt: input.ok ? undefined : now,
      successCount: record.health.successCount + (input.ok ? 1 : 0),
      failureCount: record.health.failureCount + (input.ok ? 0 : 1),
    }
    record.updatedAt = now
    return { value: undefined, changed: true }
  })
}

export async function markAccessExpired(providerID: string, namespace: string, recordID: string, store: OAuthPoolStore) {
  const normalized = normalizeNamespace(namespace)
  await store.updateBestEffort((data) => {
    const provider = data.providers[providerID]
    if (!provider || provider.type !== "oauth") return { value: undefined, changed: false }
    const record = provider.records.find((item) => item.id === recordID)
    if (!record || record.namespace !== normalized) return { value: undefined, changed: false }
    record.access = ""
    record.expires = 0
    record.updatedAt = Date.now()
    return { value: undefined, changed: true }
  })
}

export async function getPoolUsage(providerID: string, namespace = "default", store: OAuthPoolStore, configDir: string) {
  const normalized = normalizeNamespace(namespace)
  const result = await store.snapshot(providerID, normalized)
  const activeID = selectRecordID(normalized, result)
  return Promise.all(
    result.records.map(async (record) => ({
      id: record.id,
      label: await displayLabel(record, configDir),
      isActive: record.id === activeID,
      health: {
        successCount: record.health.successCount,
        failureCount: record.health.failureCount,
        lastStatusCode: record.health.lastStatusCode,
        cooldownUntil: record.health.cooldownUntil,
      },
    })),
  )
}

export async function setActive(providerID: string, namespace: string, recordID: string, store: OAuthPoolStore) {
  const normalized = normalizeNamespace(namespace)
  return store.update((data) => {
    const provider = data.providers[providerID]
    if (!provider || provider.type !== "oauth") return { value: false, changed: false }
    const record = provider.records.find((item) => item.id === recordID)
    if (!record || record.namespace !== normalized) return { value: false, changed: false }
    const order = recordIDsForNamespace(provider, normalized)
    provider.order[normalized] = [recordID, ...order.filter((id) => id !== recordID)]
    provider.active[normalized] = recordID
    return { value: true, changed: true }
  })
}

export async function updateRecord(
  providerID: string,
  recordID: string,
  namespace: string,
  update: { access?: string; refresh?: string; expires?: number; label?: string },
  store: OAuthPoolStore,
) {
  const normalized = normalizeNamespace(namespace)
  return store.update((data) => {
    const provider = data.providers[providerID]
    if (!provider || provider.type !== "oauth") return { value: false, changed: false }
    const record = provider.records.find((item) => item.id === recordID && item.namespace === normalized)
    if (!record) return { value: false, changed: false }
    if (update.access !== undefined) record.access = update.access
    if (update.refresh !== undefined) record.refresh = update.refresh
    if (update.expires !== undefined) record.expires = update.expires
    if (update.label !== undefined) record.label = update.label
    record.updatedAt = Date.now()
    return { value: true, changed: true }
  })
}

export async function removeRecord(providerID: string, recordID: string, namespace = "default", store: OAuthPoolStore) {
  const normalized = normalizeNamespace(namespace)
  return store.update<{ removed: boolean; remaining: number }>((data) => {
    const provider = data.providers[providerID]
    if (!provider || provider.type !== "oauth") return { value: { removed: false, remaining: 0 }, changed: false }
    const index = provider.records.findIndex((record) => record.id === recordID && record.namespace === normalized)
    if (index === -1) {
      return { value: { removed: false, remaining: provider.records.filter((record) => record.namespace === normalized).length }, changed: false }
    }

    provider.records.splice(index, 1)
    provider.order[normalized] = (provider.order[normalized] ?? []).filter((id) => id !== recordID)
    if (provider.active[normalized] === recordID) provider.active[normalized] = recordIDsForNamespace(provider, normalized)[0]

    const remaining = provider.records.filter((record) => record.namespace === normalized).length
    if (remaining === 0) {
      delete provider.order[normalized]
      delete provider.active[normalized]
    }
    if (provider.records.length === 0) delete data.providers[providerID]
    return { value: { removed: true, remaining }, changed: true }
  })
}

export async function fetchUsage(
  providerID: string,
  namespace = "default",
  recordID: string | undefined,
  modelID: string | undefined,
  store: OAuthPoolStore,
) {
  const record = await getRecord(providerID, normalizeNamespace(namespace), recordID, store)
  if (!record?.access) return null
  return usage({ ...record, modelID })
}

export async function fetchWeeklyQuotaScore(
  providerID: string,
  namespace = "default",
  recordID: string | undefined,
  modelID: string | undefined,
  store: OAuthPoolStore,
  configDir: string,
) {
  const record = await getRecord(providerID, normalizeNamespace(namespace), recordID, store)
  if (!record?.access) return null
  return quotaScore({ ...record, modelID }, configDir)
}

async function getRecord(providerID: string, namespace: string, recordID: string | undefined, store: OAuthPoolStore) {
  const result = await store.snapshot(providerID, namespace)
  const activeID = recordID ?? selectRecordID(namespace, result)
  const record = result.records.find((item) => item.id === activeID && item.namespace === namespace)
  if (!record) return undefined
  return {
    providerID,
    recordID: record.id,
    namespace,
    updatedAt: record.updatedAt,
    access: record.access,
    refresh: record.refresh,
    accountId: record.accountId,
    enterpriseUrl: record.enterpriseUrl,
    label: record.label,
  } satisfies OAuthAccountContext
}

function selectRecordID(
  namespace: string,
  provider: { activeID?: string; orderedIDs: string[]; records: Array<{ id: string; namespace: string; health: { cooldownUntil?: number } }> },
) {
  const now = Date.now()
  const active = provider.records.find((item) => item.id === provider.activeID && item.namespace === namespace)
  if (active && (!active.health.cooldownUntil || active.health.cooldownUntil <= now)) return active.id
  return (
    provider.orderedIDs.find((id) => {
      const record = provider.records.find((item) => item.id === id && item.namespace === namespace)
      return !record?.health.cooldownUntil || record.health.cooldownUntil <= now
    }) ??
    // All accounts on cooldown — use the first one as least-bad fallback so requests
    // continue rather than failing entirely. The account may 429; retries will re-rotate.
    provider.orderedIDs[0]
  )
}

function recordIDsForNamespace(provider: { records: Array<{ id: string; namespace: string }>; order: Record<string, string[] | undefined> }, namespace: string) {
  const ids = provider.records.filter((record) => record.namespace === namespace).map((record) => record.id)
  return normalizeOrder(ids, provider.order[namespace] ?? [])
}

function mergeProviders(providers: OAuthPoolProvider[]) {
  const [first, ...rest] = providers
  if (!first) return undefined
  const merged: OAuthPoolProvider = {
    type: "oauth",
    active: { ...first.active },
    order: { ...first.order },
    records: [...first.records],
  }
  for (const provider of rest) {
    for (const record of provider.records) {
      if (!merged.records.some((item) => item.id === record.id && item.namespace === record.namespace)) merged.records.push(record)
    }
    for (const [namespace, order] of Object.entries(provider.order)) {
      merged.order[namespace] = [
        ...(merged.order[namespace] ?? []),
        ...(order ?? []).filter((id) => !(merged.order[namespace] ?? []).includes(id)),
      ]
    }
    for (const [namespace, id] of Object.entries(provider.active)) {
      merged.active[namespace] ??= id
    }
  }
  return merged
}

function normalizeOrder(ids: string[], order: string[]) {
  return [...order.filter((id, index) => ids.includes(id) && order.indexOf(id) === index), ...ids.filter((id) => !order.includes(id))]
}

function normalizeNamespace(namespace: string | undefined) {
  return namespace?.trim() || "default"
}
