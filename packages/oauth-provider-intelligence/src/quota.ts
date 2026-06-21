import type { OAuthAccountContext } from "@opencode-ai/plugin"

type AnthropicUsage = {
  fiveHour?: { utilization: number; resetsAt?: string }
  sevenDay?: { utilization: number; resetsAt?: string }
  sevenDaySonnet?: { utilization: number; resetsAt?: string }
}

export async function quotaScore(account: OAuthAccountContext & { modelID?: string }, _configDir: string) {
  if (account.providerID === "anthropic") {
    const value = await usage(account)
    const anthropic = value as AnthropicUsage | null
    const utilization = anthropic?.sevenDaySonnet?.utilization ?? anthropic?.sevenDay?.utilization
    return utilization === undefined ? null : 100 - utilization
  }

  if (account.providerID === "antigravity") return fetchGoogleWeeklyQuotaScore(account.access)

  if (account.providerID === "google") return fetchGoogleWeeklyQuotaScore(account.access)

  if (account.providerID === "openai") return fetchOpenAIWeeklyQuotaScore(account.access, account.accountId)
  return null
}

export async function usage(account: OAuthAccountContext & { modelID?: string }) {
  if (account.providerID !== "anthropic") return null
  if (!account.access) return null

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${account.access}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: controller.signal,
    })

    if (!response.ok) return null
    const data = (await response.json()) as {
      five_hour?: { utilization: number; resets_at?: string }
      seven_day?: { utilization: number; resets_at?: string }
      seven_day_sonnet?: { utilization: number; resets_at?: string }
    }

    return {
      fiveHour: data.five_hour
        ? { utilization: Math.round(data.five_hour.utilization), resetsAt: data.five_hour.resets_at }
        : undefined,
      sevenDay: data.seven_day
        ? { utilization: Math.round(data.seven_day.utilization), resetsAt: data.seven_day.resets_at }
        : undefined,
      sevenDaySonnet: data.seven_day_sonnet
        ? { utilization: Math.round(data.seven_day_sonnet.utilization), resetsAt: data.seven_day_sonnet.resets_at }
        : undefined,
    } satisfies AnthropicUsage
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchOpenAIWeeklyQuotaScore(access: string, accountId?: string): Promise<number | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const headers = new Headers({ Authorization: `Bearer ${access}` })
    if (accountId) headers.set("ChatGPT-Account-Id", accountId)
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers, signal: controller.signal })
    if (!response.ok) return null
    return scoreOpenAIUsage(await response.json())
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchGoogleWeeklyQuotaScore(access: string): Promise<number | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const response = await fetch("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
        "User-Agent": "google-api-nodejs-client/9.15.1",
      },
      body: JSON.stringify({
        metadata: {
          ideType: "ANTIGRAVITY",
          platform: "PLATFORM_UNSPECIFIED",
          pluginType: "GEMINI",
        },
      }),
      signal: controller.signal,
    })
    if (!response.ok) return null
    return scoreGoogleLoadCodeAssist(await response.json())
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function scoreOpenAIUsage(value: unknown): number | null {
  const rateLimitScore = scoreOpenAIRateLimitWindows(value)
  if (rateLimitScore !== null) return rateLimitScore

  const numbers = collectNumbers(value)
  return (
    bestNumber(numbers, (valuePath) => valuePath.includes("weekly") && valuePath.includes("limit") && !valuePath.includes("used")) ??
    bestNumber(numbers, (valuePath) => valuePath.includes("weekly") && valuePath.includes("remaining")) ??
    inverseBestNumber(numbers, (valuePath) => valuePath.includes("weekly") && (valuePath.includes("used") || valuePath.includes("usage")))
  )
}

function scoreOpenAIRateLimitWindows(value: unknown): number | null {
  if (!value || typeof value !== "object") return null
  const rateLimit = (value as { rate_limit?: unknown }).rate_limit
  if (!rateLimit || typeof rateLimit !== "object") return null
  const usedPercents = ["primary_window", "secondary_window"]
    .map((key) => (rateLimit as Record<string, unknown>)[key])
    .map((window) => (window && typeof window === "object" ? (window as { used_percent?: unknown }).used_percent : undefined))
    .filter((usedPercent): usedPercent is number => typeof usedPercent === "number" && Number.isFinite(usedPercent))

  if (usedPercents.length === 0) return null
  return Math.min(...usedPercents.map((usedPercent) => Math.max(0, 100 - usedPercent)))
}

function scoreGoogleLoadCodeAssist(value: unknown): number | null {
  if (!value || typeof value !== "object") return null
  const paidTier = (value as { paidTier?: unknown }).paidTier
  if (!paidTier || typeof paidTier !== "object") return null
  const availableCredits = (paidTier as { availableCredits?: unknown }).availableCredits
  if (!Array.isArray(availableCredits)) return null

  for (const credit of availableCredits) {
    if (!credit || typeof credit !== "object") continue
    const item = credit as Record<string, unknown>
    if (String(item.creditType ?? "").toLowerCase() !== "google_one_ai") continue
    const creditAmount = parseQuotaNumber(item.creditAmount)
    const minCreditAmount = parseQuotaNumber(item.minimumCreditAmountForUsage)
    if (creditAmount === undefined || minCreditAmount === undefined) continue
    return creditAmount - minCreditAmount
  }

  return null
}

function parseQuotaNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

function collectNumbers(value: unknown, valuePath: string[] = []): Array<{ path: string[]; value: number }> {
  if (typeof value === "number" && Number.isFinite(value)) return [{ path: valuePath, value }]
  if (!value || typeof value !== "object") return []
  if (Array.isArray(value)) return value.flatMap((item, index) => collectNumbers(item, valuePath.concat(String(index))))
  return Object.entries(value).flatMap(([key, item]) => collectNumbers(item, valuePath.concat(key.toLowerCase())))
}

function bestNumber(numbers: Array<{ path: string[]; value: number }>, match: (valuePath: string) => boolean) {
  return numbers
    .filter((item) => match(item.path.join(".")))
    .map((item) => item.value)
    .sort((a, b) => b - a)[0]
}

function inverseBestNumber(numbers: Array<{ path: string[]; value: number }>, match: (valuePath: string) => boolean) {
  const value = bestNumber(numbers, match)
  // Can't derive a meaningful [0,100] score from a raw "used" count without knowing the limit
  return value === undefined ? undefined : null
}
