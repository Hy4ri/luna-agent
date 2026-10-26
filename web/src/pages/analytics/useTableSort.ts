import { computed, ref } from "vue"

type SortValue = string | number | null | undefined

export function useTableSort<T, K extends string>(
  rows: () => readonly T[],
  values: Record<K, (row: T) => SortValue>,
  initialKey: NoInfer<K>,
  initialDescending = true,
) {
  const sortKey = ref<string>(initialKey)
  const descending = ref(initialDescending)
  function sortBy(key: K) {
    const first = rows()[0]
    descending.value = sortKey.value === key ? !descending.value : first === undefined || typeof values[key](first) !== "string"
    sortKey.value = key
  }
  const sortedRows = computed(() => [...rows()].sort((a, b) => {
    const left = values[sortKey.value as K](a)
    const right = values[sortKey.value as K](b)
    // Keep unreported values last in both directions.
    if (left == null) return right == null ? 0 : 1
    if (right == null) return -1
    const order = typeof left === "number" && typeof right === "number"
      ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true })
    return descending.value ? -order : order
  }))
  return { sortKey, descending, sortBy, sortedRows }
}
