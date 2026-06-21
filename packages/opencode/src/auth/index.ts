import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { OAuthPoolStore } from "@opencode-ai/plugin"
import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import {
  AUTH_VERSION,
  activeOAuth,
  createPoolStore,
  toOAuthProviderPool,
  unwrapProviders,
  updateActiveOAuthRecord,
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
  readonly poolStore?: () => OAuthPoolStore
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
      yield* fsys
        .writeJson(file, { version: AUTH_VERSION, providers: data }, 0o600)
        .pipe(Effect.mapError(fail("Failed to write auth data")))
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

    // Singleton so all callers share the same serial update queue (prevents TOCTOU races)
    const poolStoreInstance = createPoolStore({ allRaw, writeRaw, decode })
    const poolStore = (): OAuthPoolStore => poolStoreInstance

    return Service.of({ get, all, set, remove, poolStore })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer))

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

export * as Auth from "."
