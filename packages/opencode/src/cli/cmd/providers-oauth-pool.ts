import { Effect, Option } from "effect"
import type { OAuthPoolHook, OAuthPoolStore } from "@opencode-ai/plugin"
import { Auth } from "../../auth"
import { Plugin } from "../../plugin"
import { fail } from "../effect-cmd"
import { UI } from "../ui"
import * as Prompt from "../effect/prompt"

const promptValue = <Value>(value: Option.Option<Value>) => {
  if (Option.isNone(value)) return Effect.die(new UI.CancelledError())
  return Effect.succeed(value.value)
}

function resolvePool(auth: Auth.Interface, plugin: Plugin.Interface) {
  return Effect.gen(function* () {
    const store = auth.poolStore?.()
    if (!store) return undefined
    const pool = (yield* plugin.list()).find((hook) => hook.oauth?.pool)?.oauth?.pool
    if (!pool) return undefined
    return { store, pool } satisfies { store: OAuthPoolStore; pool: OAuthPoolHook }
  })
}

// Routes a new OAuth credential into the account pool. Returns true when handled.
export function poolUpsert(input: { auth: Auth.Interface; plugin: Plugin.Interface; key: string; info: Auth.Info }) {
  return Effect.gen(function* () {
    if (input.info.type !== "oauth") return false
    const resolved = yield* resolvePool(input.auth, input.plugin)
    if (!resolved?.pool.upsert) return false
    const norm = input.key.replace(/\/+$/, "")
    yield* Effect.promise(() =>
      resolved.pool.upsert!({ providerID: norm, aliases: [input.key, norm + "/"], account: input.info as never, store: resolved.store }),
    )
    return true
  })
}

// Prints the per-account breakdown for a pooled provider. Returns true when rendered.
export function renderPoolAccounts(input: { auth: Auth.Interface; plugin: Plugin.Interface; providerID: string; result: Auth.Info; name: string }) {
  return Effect.gen(function* () {
    if (input.result.type !== "oauth") return false
    const resolved = yield* resolvePool(input.auth, input.plugin)
    if (!resolved?.pool.snapshot) return false
    const snapshot = yield* Effect.promise(() => resolved.pool.snapshot!({ providerID: input.providerID, store: resolved.store }))
    if (snapshot.records.length <= 1) return false
    yield* Prompt.log.info(`${input.name} ${UI.Style.TEXT_DIM}${input.result.type}, ${snapshot.records.length} accounts`)
    for (const record of snapshot.records) {
      const active = record.id === snapshot.activeID ? " *" : ""
      yield* Prompt.log.info(`  ${(record.label || record.id) + active} ${UI.Style.TEXT_DIM}${record.health.failureCount} failures`)
    }
    return true
  })
}

// Prompts to remove a single account from a pooled provider. Returns true when one was removed.
export function logoutPoolAccount(input: { auth: Auth.Interface; plugin: Plugin.Interface; providerID: string }) {
  return Effect.gen(function* () {
    const resolved = yield* resolvePool(input.auth, input.plugin)
    if (!resolved?.pool.snapshot || !resolved.pool.removeRecord) return false
    const snapshot = yield* Effect.promise(() => resolved.pool.snapshot!({ providerID: input.providerID, store: resolved.store }))
    if (snapshot.records.length <= 1) return false
    const selected = yield* promptValue(
      yield* Prompt.autocomplete({
        message: "Select account",
        maxItems: 8,
        options: [
          { label: "All accounts", value: "" },
          ...snapshot.records.map((record) => ({
            label: record.label || record.id,
            value: record.id,
            hint: record.id === snapshot.activeID ? "active" : undefined,
          })),
        ],
      }),
    )
    if (selected === "") {
      // "All accounts" selected — remove the entire provider entry
      yield* Effect.orDie(input.auth.remove(input.providerID))
      return true
    }
    const result = yield* Effect.promise(() => resolved.pool.removeRecord!({ providerID: input.providerID, recordID: selected, store: resolved.store }))
    if (!result.removed) return yield* fail("Selected account was not found")
    return true
  })
}
