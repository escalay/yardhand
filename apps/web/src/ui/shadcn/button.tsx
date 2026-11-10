/**
 * The buttons: `default` is graphite with a lit top, `primary` the one signal-blue call to action in a group, `muted`
 * the light one, `ghost` and `link` for quiet actions, `danger` for the irreversible. Each has a layered edge;
 * the focus ring shows for the keyboard only.
 */
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type * as React from 'react'
import { cn } from '@/ui/cn'

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 font-medium whitespace-nowrap transition duration-200 ease-out outline-none active:scale-98 focus-visible:ring-3 focus-visible:ring-primary/30 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'bg-linear-to-b from-inverse-highlight to-inverse text-inverse-foreground shadow-button-inverse hover:brightness-125',
        primary:
          'bg-linear-to-b from-primary-highlight to-primary text-primary-foreground shadow-button-primary hover:brightness-110',
        muted: 'bg-linear-to-b from-background to-muted text-foreground shadow-button-muted hover:brightness-97',
        ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
        link: 'h-auto px-0 text-foreground underline-offset-4 hover:text-muted-foreground hover:underline',
        danger:
          'bg-linear-to-b from-error/90 to-error text-white shadow-[0_0_0_1px_var(--color-error),inset_0_1px_0_rgb(255_255_255/0.2)] hover:brightness-110',
      },
      size: {
        default: 'h-10 rounded-lg px-4 text-sm',
        sm: 'h-8 rounded-md px-3 text-sm',
        xs: 'h-7 rounded-md px-2 text-xs',
        lg: 'h-11 rounded-lg px-5 text-sm',
        icon: 'size-9 rounded-lg',
        'icon-sm': 'size-8 rounded-md',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child (a link) with the button's look. */
    asChild?: boolean
  }

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button'
  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
