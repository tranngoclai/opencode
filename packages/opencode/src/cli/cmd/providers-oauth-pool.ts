import { Effect, Option } from "effect"
import { Auth } from "../../auth"
import { fail } from "../effect-cmd"
import { UI } from "../ui"
import * as Prompt from "../effect/prompt"

const promptValue = <Value>(value: Option.Option<Value>) => {
  if (Option.isNone(value)) return Effect.die(new UI.CancelledError())
  return Effect.succeed(value.value)
}

// Prints the per-account breakdown for a pooled OAuth provider. Returns true when rendered.
export function renderPoolAccounts(input: { auth: Auth.Interface; providerID: string; result: Auth.Info; name: string }) {
  return Effect.gen(function* () {
    if (input.result.type !== "oauth") return false
    const accounts = yield* Effect.orDie(input.auth.accounts(input.providerID))
    if (accounts.length <= 1) return false
    yield* Prompt.log.info(`${input.name} ${UI.Style.TEXT_DIM}${input.result.type}, ${accounts.length} accounts`)
    for (const account of accounts) {
      const active = account.active ? " *" : ""
      yield* Prompt.log.info(
        `  ${(account.label || account.accountId || account.id) + active} ${UI.Style.TEXT_DIM}${account.health.failureCount} failures`,
      )
    }
    return true
  })
}

// Prompts to remove a single account from a pooled provider. Returns true when one was removed.
export function logoutPoolAccount(input: { auth: Auth.Interface; providerID: string }) {
  return Effect.gen(function* () {
    const accounts = yield* Effect.orDie(input.auth.accounts(input.providerID))
    if (accounts.length <= 1) return false
    const selected = yield* promptValue(
      yield* Prompt.autocomplete({
        message: "Select account",
        maxItems: 8,
        options: [
          { label: "All accounts", value: "" },
          ...accounts.map((account) => ({
            label: account.label || account.accountId || account.id,
            value: account.id,
            hint: account.active ? "active" : undefined,
          })),
        ],
      }),
    )
    if (selected === "") {
      // "All accounts" selected — remove the entire provider entry
      yield* Effect.orDie(input.auth.remove(input.providerID))
      return true
    }
    const result = yield* Effect.orDie(input.auth.removeAccount(input.providerID, selected))
    if (!result.removed) return yield* fail("Selected account was not found")
    return true
  })
}
