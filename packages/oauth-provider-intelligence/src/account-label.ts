import type { OAuthAccountContext } from "@opencode-ai/plugin"
import { firstString } from "./util.js"

export async function accountLabel(account: OAuthAccountContext, _configDir: string) {
  if (account.label && !isGeneratedLabel(account.label)) return account.label
  const tokenLabel = extractOpenAITokenProfileLabel(account)
  if (tokenLabel) return tokenLabel
  if (account.providerID === "antigravity") return fetchGoogleProfileLabel(account.access)
  if (account.providerID === "google") return fetchGoogleProfileLabel(account.access)
  if (account.providerID === "anthropic") return fetchAnthropicProfileLabel(account.access)
  return undefined
}

export async function displayLabel(account: OAuthAccountContext, configDir: string) {
  if (account.label && !isGeneratedLabel(account.label)) return account.label
  return (await accountLabel(account, configDir)) ?? account.label
}

export async function retryAfterMs(providerID: string, response: Response) {
  if (providerID === "openai") return parseOpenAIRetryAfterMs(response)
  return undefined
}

async function parseOpenAIRetryAfterMs(response: Response) {
  try {
    const body = (await response.clone().json()) as {
      error?: { type?: string; resets_at?: number; resets_in_seconds?: number }
    }
    if (body.error?.type !== "usage_limit_reached") return undefined
    if (body.error.resets_at && body.error.resets_at * 1000 > Date.now()) return body.error.resets_at * 1000 - Date.now()
    if (body.error.resets_in_seconds && body.error.resets_in_seconds > 0) return body.error.resets_in_seconds * 1000
  } catch {}
  return undefined
}

function isGeneratedLabel(label: string) {
  return label === "default" || /^Account \d+$/.test(label)
}

function extractOpenAITokenProfileLabel(account: OAuthAccountContext) {
  if (account.providerID !== "openai") return undefined
  const claims = parseJwtClaims(account.access)
  return claims?.email ?? claims?.["https://api.openai.com/profile"]?.email
}

function parseJwtClaims(token: string) {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString()) as {
      email?: string
      "https://api.openai.com/profile"?: { email?: string }
    }
  } catch {
    return undefined
  }
}

async function fetchAnthropicProfileLabel(access: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1500)
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/profile", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${access}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    const data = (await response.json()) as {
      account?: { email?: unknown; display_name?: unknown; full_name?: unknown }
    }
    return firstString(data.account?.email, data.account?.display_name, data.account?.full_name)
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchGoogleProfileLabel(access: string) {
  if (!access) return undefined

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1500)
  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo?alt=json", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${access}`,
        "User-Agent": "antigravity/1.0",
      },
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    const data = (await response.json()) as { email?: unknown; name?: unknown; given_name?: unknown }
    return firstString(data.email, data.name, data.given_name)
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}
