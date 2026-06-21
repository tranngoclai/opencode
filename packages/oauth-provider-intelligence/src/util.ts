import os from "node:os"
import path from "node:path"

export function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim()
}

export function xdgConfigHome() {
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
}
