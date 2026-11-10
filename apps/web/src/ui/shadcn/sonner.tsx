import { Toaster as Sonner, type ToasterProps } from 'sonner'

/** Toasts in Yardhand's look: square, hairline, ink on white; light only. */
export const Toaster = (props: ToasterProps) => (
  <Sonner
    theme="light"
    position="bottom-right"
    toastOptions={{
      classNames: {
        toast: '!rounded-none !border-border !bg-card !text-foreground !shadow-[var(--shadow-overlay)] !font-sans',
        description: '!text-muted-foreground',
      },
    }}
    {...props}
  />
)
