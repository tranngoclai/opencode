import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import {
  activeOAuth,
  listOAuthAccounts,
  removeOAuthAccount,
  rotateOAuthAccount,
  toOAuthProviderPool,
  unwrapProviders,
  updateActiveOAuthRecord,
  type OAuthAccount,
  type RawProvider,
} from "./oauth-pool"
export { Oauth, Api, WellKnown, Info, AuthError } from "./schema"
import { Oauth, Api, WellKnown, Info, AuthError } from "./schema"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
  readonly accounts: (providerID: string) => Effect.Effect<OAuthAccount[], AuthError>
  readonly removeAccount: (providerID: string, recordID: string) => Effect.Effect<{ removed: boolean; remaining: number }, AuthError>
  readonly rotate: (providerID: string, input?: { cooldownUntil?: number; statusCode?: number }) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownOption(Info)

    const allRaw = Effect.fn("Auth.allRaw")(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
          return unwrapProviders(JSON.parse(process.env.OPENCODE_AUTH_CONTENT))
        } catch (err) {}
      }

      return unwrapProviders(yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({}))))
    })

    const writeRaw = Effect.fn("Auth.writeRaw")(function* (data: Record<string, RawProvider>) {
      yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    const all = Effect.fn("Auth.all")(function* () {
      return Record.filterMap(yield* allRaw(), (value) => {
        const active = activeOAuth(value)
        if (active) return Result.succeed(active)
        return Result.fromOption(decode(value), () => undefined)
      })
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      const value = (yield* allRaw())[providerID]
      const active = activeOAuth(value)
      if (active) return active
      return Result.getOrUndefined(Result.fromOption(decode(value), () => undefined))
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* allRaw()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      const existing = toOAuthProviderPool(data[norm])
      if (info.type === "oauth" && existing) {
        yield* writeRaw({ ...data, [norm]: updateActiveOAuthRecord(existing, info) })
        return
      }
      yield* writeRaw({ ...data, [norm]: info })
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* allRaw()
      delete data[key]
      delete data[norm]
      yield* writeRaw(data)
    })

    const accounts = Effect.fn("Auth.accounts")(function* (providerID: string) {
      return listOAuthAccounts((yield* allRaw())[providerID])
    })

    const removeAccount = Effect.fn("Auth.removeAccount")(function* (providerID: string, recordID: string) {
      const data = yield* allRaw()
      const result = removeOAuthAccount(data[providerID], recordID)
      if (!result.removed) return { removed: false, remaining: result.remaining }
      if (result.provider) yield* writeRaw({ ...data, [providerID]: result.provider })
      else {
        const next = { ...data }
        delete next[providerID]
        yield* writeRaw(next)
      }
      return { removed: true, remaining: result.remaining }
    })

    const rotate = Effect.fn("Auth.rotate")(function* (providerID: string, input?: { cooldownUntil?: number; statusCode?: number }) {
      const data = yield* allRaw()
      const provider = rotateOAuthAccount(data[providerID], input)
      if (!provider) return
      yield* writeRaw({ ...data, [providerID]: provider })
    })

    return Service.of({ get, all, set, remove, accounts, removeAccount, rotate })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer))

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

export * as Auth from "."
