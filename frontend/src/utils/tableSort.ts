import { useCallback, useState } from 'react'

export type SortDirection = 'asc' | 'desc'

export type SortState<Field extends string> = {
  field: Field
  direction: SortDirection
}

export type SortableValue = string | number | boolean | Date | null | undefined

type SortAccessors<T, Field extends string> = Record<Field, (item: T) => SortableValue>

function normalizeSortableValue(value: SortableValue): string | number | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'boolean') return value ? 1 : 0
  return value
}

export function compareSortableValues(a: SortableValue, b: SortableValue, locale: string): number {
  const normalizedA = normalizeSortableValue(a)
  const normalizedB = normalizeSortableValue(b)

  if (normalizedA === null && normalizedB === null) return 0
  if (normalizedA === null) return 1
  if (normalizedB === null) return -1

  if (typeof normalizedA === 'string' && typeof normalizedB === 'string') {
    return normalizedA.localeCompare(normalizedB, locale, {
      numeric: true,
      sensitivity: 'base',
    })
  }

  return Number(normalizedA) - Number(normalizedB)
}

export function sortTableItems<T, Field extends string>(
  items: T[],
  sortState: SortState<Field>,
  accessors: SortAccessors<T, Field>,
  locale: string,
  fallbackAccessor?: (item: T) => SortableValue
): T[] {
  const getValue = accessors[sortState.field]
  const directionMultiplier = sortState.direction === 'asc' ? 1 : -1

  return [...items].sort((a, b) => {
    const primary = compareSortableValues(getValue(a), getValue(b), locale) * directionMultiplier
    if (primary !== 0) return primary
    if (!fallbackAccessor) return 0
    return compareSortableValues(fallbackAccessor(a), fallbackAccessor(b), locale)
  })
}

export function useTableSort<Field extends string>(initialState: SortState<Field>) {
  const [sortState, setSortState] = useState<SortState<Field>>(initialState)

  const requestSort = useCallback((field: Field, defaultDirection: SortDirection = 'asc') => {
    setSortState((current) => (
      current.field === field
        ? { field, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { field, direction: defaultDirection }
    ))
  }, [])

  return { sortState, requestSort }
}
