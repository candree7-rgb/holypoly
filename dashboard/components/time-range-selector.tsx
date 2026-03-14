'use client'

export type TimeRange = '24H' | '7D' | '1M' | '3M' | 'ALL'

export const TIME_RANGES: { value: TimeRange; label: string; days?: number }[] = [
  { value: '24H', label: '24H', days: 1 },
  { value: '7D', label: '7D', days: 7 },
  { value: '1M', label: '1M', days: 30 },
  { value: '3M', label: '3M', days: 90 },
  { value: 'ALL', label: 'All' },
]

interface Props {
  selected: TimeRange
  onSelect: (range: TimeRange) => void
}

export default function TimeRangeSelector({ selected, onSelect }: Props) {
  return (
    <div className="flex gap-1 bg-muted rounded-lg p-1">
      {TIME_RANGES.map((r) => (
        <button
          key={r.value}
          onClick={() => onSelect(r.value)}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            selected === r.value
              ? 'bg-primary text-primary-foreground font-medium'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  )
}
