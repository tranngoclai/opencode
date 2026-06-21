import { Auth } from "@/auth"
import { Plugin } from "@/plugin"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { SessionRetry } from "./retry"

// Reports per-request OAuth pool outcomes (success, auth failure, rate limit) so the
// provider-intelligence plugin can rotate accounts, track health, and apply cooldowns.
export const recordOAuthOutcome = Effect.fn("SessionProcessor.recordOAuthOutcome")(function* (input: {
  providerID: string
  plugin: Plugin.Interface
  ok: boolean
  error?: SessionRetry.Err
  wait?: number
}) {
  const authOption = yield* Effect.serviceOption(Auth.Service)
  if (authOption._tag === "None") return
  const store = authOption.value.poolStore?.()
  if (!store) return
  const hooks = yield* input.plugin.list()
  const pool = hooks.find((hook) => hook.oauth?.pool)?.oauth?.pool
  if (!pool) return

  // Namespace is always "default" — the session processor has no per-request namespace context
  const snapshot = yield* Effect.promise(() => store.snapshot(input.providerID))
  const recordID = snapshot.activeID ?? snapshot.orderedIDs[0]
  if (!recordID) return

  const statusCode = SessionV1.APIError.isInstance(input.error) ? input.error.data.statusCode : undefined
  if (!input.ok && statusCode && [401, 403].includes(statusCode)) {
    yield* Effect.promise(() => pool.markAccessExpired?.({ providerID: input.providerID, namespace: "default", recordID, store }) ?? Promise.resolve()).pipe(
      Effect.ignore,
    )
  }

  const retryAfterMs = yield* Effect.gen(function* () {
    if (!input.error || !SessionV1.APIError.isInstance(input.error)) return undefined
    const retryAfter = hooks.find((hook) => hook.oauth?.retryAfterMs)?.oauth?.retryAfterMs
    if (!retryAfter) return undefined
    const response = new Response(input.error.data.responseBody, {
      status: input.error.data.statusCode,
      headers: input.error.data.responseHeaders,
    })
    return yield* Effect.promise(() => retryAfter({ providerID: input.providerID, response })).pipe(Effect.catch(() => Effect.succeed(undefined)))
  })
  const cooldownUntil = input.ok ? undefined : Date.now() + (retryAfterMs ?? input.wait ?? SessionRetry.RETRY_INITIAL_DELAY)

  yield* Effect.promise(() =>
    pool.recordOutcome?.({
      providerID: input.providerID,
      namespace: "default",
      recordID,
      statusCode: statusCode ?? 0,
      ok: input.ok,
      cooldownUntil,
      store,
    }) ?? Promise.resolve(),
  ).pipe(Effect.ignore)

  if (!input.ok) {
    yield* Effect.promise(() => pool.moveToBack?.({ providerID: input.providerID, namespace: "default", recordID, store }) ?? Promise.resolve()).pipe(
      Effect.ignore,
    )
  }
})
