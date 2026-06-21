import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import path from "node:path"
import { accountLabel, retryAfterMs } from "./account-label.js"
import {
  fetchUsage,
  fetchWeeklyQuotaScore,
  getPoolUsage,
  list,
  markAccessExpired,
  moveToBack,
  orderedIDs,
  recordOutcome,
  removeRecord,
  setActive,
  snapshot,
  updateRecord,
  upsert,
} from "./pool.js"
import { quotaScore, usage } from "./quota.js"
import { xdgConfigHome } from "./util.js"

type Options = PluginOptions & {
  configDir?: string
}

export async function ProviderIntelligencePlugin(_input: PluginInput, options?: Options): Promise<Hooks> {
  const configDir = options?.configDir ?? process.env.OPENCODE_CONFIG_DIR ?? path.join(xdgConfigHome(), "opencode")
  return {
    oauth: {
      accountLabel(account) {
        return accountLabel(account, configDir)
      },
      quotaScore(account) {
        return quotaScore(account, configDir)
      },
      usage(account) {
        return usage(account)
      },
      retryAfterMs(input) {
        return retryAfterMs(input.providerID, input.response)
      },
      pool: {
        upsert(input) {
          return upsert(input.providerID, input.namespace, input.aliases, input.account, input.store)
        },
        snapshot(input) {
          return snapshot(input.providerID, input.namespace, input.store, configDir)
        },
        list(input) {
          return list(input.providerID, input.namespace, input.store, configDir)
        },
        orderedIDs(input) {
          return orderedIDs(input.providerID, input.namespace, input.store)
        },
        moveToBack(input) {
          return moveToBack(input.providerID, input.namespace, input.recordID, input.store)
        },
        recordOutcome(input) {
          return recordOutcome(input)
        },
        markAccessExpired(input) {
          return markAccessExpired(input.providerID, input.namespace, input.recordID, input.store)
        },
        getUsage(input) {
          return getPoolUsage(input.providerID, input.namespace, input.store, configDir)
        },
        setActive(input) {
          return setActive(input.providerID, input.namespace, input.recordID, input.store)
        },
        updateRecord(input) {
          return updateRecord(input.providerID, input.recordID, input.namespace, input.update, input.store)
        },
        removeRecord(input) {
          return removeRecord(input.providerID, input.recordID, input.namespace, input.store)
        },
        fetchUsage(input) {
          return fetchUsage(input.providerID, input.namespace, input.recordID, input.modelID, input.store)
        },
        fetchWeeklyQuotaScore(input) {
          return fetchWeeklyQuotaScore(input.providerID, input.namespace, input.recordID, input.modelID, input.store, configDir)
        },
      },
    },
  }
}

export default ProviderIntelligencePlugin
