export type OAuthAccountContext = {
  providerID: string
  recordID: string
  namespace: string
  updatedAt: number
  access: string
  refresh?: string
  accountId?: string
  enterpriseUrl?: string
  label?: string
}

export type OAuthRecordMeta = Omit<OAuthAccountContext, "access" | "refresh"> & {
  id: string
  createdAt: number
  health: {
    successCount: number
    failureCount: number
    lastStatusCode?: number
    cooldownUntil?: number
    lastErrorAt?: number
  }
}

export type OAuthStoredRecord = Omit<OAuthAccountContext, "providerID" | "recordID"> & {
  id: string
  createdAt: number
  expires: number
  health: OAuthRecordMeta["health"]
}

export type OAuthPoolStore = {
  snapshot(providerID: string, namespace?: string): Promise<{
    records: Array<OAuthAccountContext & { id: string; createdAt: number; health: OAuthRecordMeta["health"] }>
    orderedIDs: string[]
    activeID?: string
  }>
  update<T>(
    fn: (store: {
      providers: Record<
        string,
        | { type: "api"; key: string; metadata?: Record<string, string> }
        | { type: "wellknown"; key: string; token: string }
        | {
            type: "oauth"
            active: Record<string, string | undefined>
            order: Record<string, string[] | undefined>
            records: OAuthStoredRecord[]
          }
      >
    }) => { value: T; changed: boolean } | Promise<{ value: T; changed: boolean }>,
  ): Promise<T>
  updateBestEffort(
    fn: (store: Parameters<OAuthPoolStore["update"]>[0] extends (store: infer Store) => unknown ? Store : never) =>
      | { value: void; changed: boolean }
      | Promise<{ value: void; changed: boolean }>,
  ): Promise<void>
}

export type OAuthPoolHook = {
  upsert?: (input: {
    providerID: string
    namespace?: string
    aliases?: string[]
    account: {
      access: string
      refresh: string
      expires: number
      accountId?: string
      enterpriseUrl?: string
      label?: string
    }
    store: OAuthPoolStore
  }) => Promise<void>
  snapshot?: (input: { providerID: string; namespace?: string; store: OAuthPoolStore }) => Promise<{
    records: OAuthRecordMeta[]
    orderedIDs: string[]
    activeID?: string
  }>
  list?: (input: { providerID: string; namespace?: string; store: OAuthPoolStore }) => Promise<OAuthRecordMeta[]>
  orderedIDs?: (input: { providerID: string; namespace?: string; store: OAuthPoolStore }) => Promise<string[]>
  moveToBack?: (input: { providerID: string; namespace: string; recordID: string; store: OAuthPoolStore }) => Promise<void>
  recordOutcome?: (input: {
    providerID: string
    namespace?: string
    recordID: string
    statusCode: number
    ok: boolean
    cooldownUntil?: number
    store: OAuthPoolStore
  }) => Promise<void>
  markAccessExpired?: (input: { providerID: string; namespace: string; recordID: string; store: OAuthPoolStore }) => Promise<void>
  getUsage?: (input: { providerID: string; namespace?: string; store: OAuthPoolStore }) => Promise<
    Array<{
      id: string
      label?: string
      isActive: boolean
      health: OAuthRecordMeta["health"]
    }>
  >
  setActive?: (input: { providerID: string; namespace: string; recordID: string; store: OAuthPoolStore }) => Promise<boolean>
  updateRecord?: (input: {
    providerID: string
    recordID: string
    namespace: string
    update: { access?: string; refresh?: string; expires?: number; label?: string }
    store: OAuthPoolStore
  }) => Promise<boolean>
  removeRecord?: (input: { providerID: string; recordID: string; namespace?: string; store: OAuthPoolStore }) => Promise<{
    removed: boolean
    remaining: number
  }>
  fetchUsage?: (input: { providerID: string; namespace?: string; recordID?: string; modelID?: string; store: OAuthPoolStore }) => Promise<unknown | null>
  fetchWeeklyQuotaScore?: (input: {
    providerID: string
    namespace?: string
    recordID?: string
    modelID?: string
    store: OAuthPoolStore
  }) => Promise<number | null>
}

export type OAuthHook = {
  accountLabel?: (account: OAuthAccountContext) => Promise<string | undefined>
  quotaScore?: (account: OAuthAccountContext & { modelID?: string }) => Promise<number | null>
  usage?: (account: OAuthAccountContext & { modelID?: string }) => Promise<unknown | null>
  retryAfterMs?: (input: { providerID: string; response: Response }) => Promise<number | undefined>
  pool?: OAuthPoolHook
}
