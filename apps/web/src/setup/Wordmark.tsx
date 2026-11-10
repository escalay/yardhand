/** The product's name as a wordmark: spaced capitals, as in the app's top bar. */
import { cn } from '@/ui/cn'

export const PRODUCT = 'Yardhand'

export const Wordmark = ({ className, inverse }: { className?: string; inverse?: boolean }) => (
  <span
    className={cn(
      'text-[13px] font-medium tracking-[0.22em] uppercase',
      inverse ? 'text-inverse-foreground' : 'text-foreground',
      className,
    )}
  >
    {PRODUCT}
  </span>
)
