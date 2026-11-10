import * as React from "react"
import { cn } from "@/ui/cn"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-20 w-full px-3 py-2 text-sm rounded-lg bg-background ring-1 ring-inset ring-border transition-shadow outline-none placeholder:text-faint-foreground focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-error",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
