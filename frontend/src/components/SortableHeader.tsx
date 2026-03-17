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
