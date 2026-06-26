import { Auth } from "@/auth"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { SessionRetry } from "./retry"

// Rotates the active OAuth account to the back of the pool on a retryable failure so the
// next attempt uses a different account. The failed account is put on cooldown for `wait`
// ms (or the provider-advertised retry-after) before it becomes eligible again.
export const rotateOnFailure = Effect.fn("SessionProcessor.rotateOnFailure")(function* (input: {
  providerID: string
  error?: SessionRetry.Err
  wait?: number
}) {
  const auth = yield* Effect.serviceOption(Auth.Service)
  if (auth._tag === "None") return
  const statusCode = SessionV1.APIError.isInstance(input.error) ? input.error.data.statusCode : undefined
  const cooldownUntil = Date.now() + (input.wait ?? SessionRetry.RETRY_INITIAL_DELAY)
  yield* auth.value.rotate(input.providerID, { cooldownUntil, statusCode }).pipe(Effect.ignore)
})
