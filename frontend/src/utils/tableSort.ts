import { useCallback, useState } from 'react'

export type SortDirection = 'asc' | 'desc'

export type SortState<Field extends string> = {
  field: Field
  direction: SortDirection
}

export type SortableValue = string | number | boolean | Date | null | undefined

type SortAccessors<T, Field extends string> = Record<Field, (item: T) => SortableValue>

/**
 * Normalize a sortable value into a primitive suitable for comparisons.
 *
 * @param value - The value to normalize; may be a string, number, boolean, Date, null, or undefined
 * @returns The normalized value: a numeric timestamp for `Date`, `1` for `true`, `0` for `false`, `null` for `null`/`undefined`, or the original string/number
 */
function normalizeSortableValue(value: SortableValue): string | number | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'boolean') return value ? 1 : 0
  return value
}

/**
 * Compare two sortable values using locale-aware string comparison or numeric comparison.
 *
 * @param a - First value to compare; may be string, number, boolean, Date, null, or undefined
 * @param b - Second value to compare; may be string, number, boolean, Date, null, or undefined
 * @param locale - Locale identifier used for string comparison
 * @returns A negative number if `a` comes before `b`, a positive number if `a` comes after `b`, or `0` if they are equivalent. `null` or `undefined` are treated as greater than any non-null value (they sort after non-null values).
 */
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

/**
 * Create a sorted copy of `items` using the provided sort state and accessor functions.
 *
 * @param sortState - The current sort field and direction to apply.
 * @param accessors - Mapping from each field to an accessor that extracts a sortable value from an item.
 * @param locale - Locale identifier used for locale-aware string comparisons.
 * @param fallbackAccessor - Optional accessor used to break ties when the primary field compares equal.
 * @returns A new array with items ordered by the value extracted from `accessors[sortState.field]` according to `sortState.direction`; when values are equal and `fallbackAccessor` is provided, its comparison determines order.
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

/**
 * Manages table sort state and provides a function to request sorting by a field.
 *
 * The returned `requestSort` toggles the direction between `'asc'` and `'desc'` when called
 * with the currently active field; when called with a different field it sets that field's
 * direction to the provided `defaultDirection`.
 *
 * @param initialState - Initial sort field and direction
 * @returns An object containing:
 *  - `sortState`: the current sort field and direction
 *  - `requestSort`: a function `(field, defaultDirection?)` to update `sortState` as described above
 */
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
