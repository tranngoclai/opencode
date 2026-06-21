import type { Hooks } from "@opencode-ai/plugin"
import { Effect } from "effect"
import { Auth } from "@/auth"

// Persists a refreshed OAuth credential, routing it into the account pool when a
// provider-intelligence upsert hook is present, otherwise falling back to a flat write.
export function persistOAuthResult(input: {
  auth: Auth.Interface
  oauth: NonNullable<Hooks["oauth"]>[]
  providerID: string
  account: { access: string; refresh: string; expires: number; accountId?: string; enterpriseUrl?: string; label?: string }
}) {
  return Effect.gen(function* () {
    const store = input.auth.poolStore?.()
    const upsert = input.oauth.find((hook) => hook.pool?.upsert)?.pool?.upsert
    if (store && upsert) {
      yield* Effect.promise(() => upsert({ providerID: input.providerID, account: input.account, store }))
      return
    }
    yield* input.auth.set(input.providerID, { type: "oauth", ...input.account })
  })
}
