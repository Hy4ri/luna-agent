import { shallowRef, watch } from "vue"
import { json, serverUrl, token } from "@/lib/api"
import type { AnalyticsSnapshot } from "@/pages/analytics/types"

// Keep only the current authenticated connection's snapshot, outside the modal lifecycle.
export const analyticsSnapshot = shallowRef<AnalyticsSnapshot | null>(null)
let generation = 0
let pending: Promise<AnalyticsSnapshot> | undefined
watch([serverUrl, token], () => {
  generation++
  analyticsSnapshot.value = null
  pending = undefined
}, { flush: "sync" })

export function loadAnalytics(force = false): Promise<AnalyticsSnapshot> {
  if (pending) return pending
  const own = generation
  const request = json<AnalyticsSnapshot>(force ? "/v1/analytics?view=overview&refresh=true" : "/v1/analytics?view=overview")
    .then(next => {
      if (own !== generation) throw new DOMException("Connection changed", "AbortError")
      analyticsSnapshot.value = next
      return next
    }).finally(() => {
      if (pending === request) pending = undefined
    })
  pending = request
  return request
}
