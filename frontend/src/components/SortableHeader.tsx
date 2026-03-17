import type { CSSProperties, ReactNode } from 'react'
import type { SortDirection, SortState } from '../utils/tableSort'

type Props<Field extends string> = {
  field: Field
  label: ReactNode
  sortState: SortState<Field>
  onSort: (field: Field, defaultDirection?: SortDirection) => void
  defaultDirection?: SortDirection
  align?: 'left' | 'right' | 'center'
  style?: CSSProperties
}

/**
 * Render a table header cell containing a full-width clickable control that triggers sorting for the specified field.
 *
 * @param field - The key of the field this header sorts.
 * @param label - Content displayed inside the header button.
 * @param sortState - Current sorting state describing the active field and direction.
 * @param onSort - Callback invoked when the header is activated; receives the field and an optional default direction.
 * @param defaultDirection - Default sort direction to apply when activating this field (`'asc'` or `'desc'`).
 * @param align - Horizontal text alignment for the header content (`'left'`, `'right'`, or `'center'`).
 * @param style - Inline styles applied to the rendered `<th>` element.
 * @returns The `<th>` element containing the sort button for the given field.
 */
export default function SortableHeader<Field extends string>({
  field,
  label,
  sortState,
  onSort,
  defaultDirection = 'asc',
  align = 'left',
  style,
}: Props<Field>) {
  const isActive = sortState.field === field
  const ariaSort = isActive ? (sortState.direction === 'asc' ? 'ascending' : 'descending') : 'none'
  const indicator = isActive ? (sortState.direction === 'asc' ? ' ^' : ' v') : ''

  return (
    <th aria-sort={ariaSort} scope="col" style={style}>
      <button
        type="button"
        onClick={() => onSort(field, defaultDirection)}
        style={{
          cursor: 'pointer',
          userSelect: 'none',
          background: 'none',
          border: 0,
          color: 'inherit',
          font: 'inherit',
          padding: 0,
          textAlign: align,
          width: '100%',
        }}
      >
        {label}{indicator}
      </button>
    </th>
  )
}
