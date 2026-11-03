import { compactNumber } from "../../lib/numbers"

export const full = (n: number | null | undefined): string =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n || 0)

export const compact = compactNumber

export const usd = (n: number | null | undefined): string =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(n || 0)

export const pct = (n: number | null | undefined): string =>
  n == null ? "Not reported" : (n * 100).toFixed(1) + "%"

export const when = (value: string | null | undefined): string =>
  value ? new Date(value).toLocaleString() : "—"

export const durationFormat = (ms: number | null | undefined): string => {
  if (ms == null) return "—"
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s"
  return (ms / 60000).toFixed(1) + "m"
}

export const COLORS = ["#b5d9ad", "#8fb9d1", "#d5ba8d", "#bb9dcb"] as const

export const FIELDS: [string, string, string][] = [
  ["input", "Uncached input", COLORS[0]],
  ["output", "Output", COLORS[1]],
  ["cacheRead", "Cache read", COLORS[2]],
  ["cacheWrite", "Cache write", COLORS[3]],
]
