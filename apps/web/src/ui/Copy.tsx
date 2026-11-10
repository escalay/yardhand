/** Copy to the clipboard, saying so in the button itself for two seconds. */
import { IconCheck, IconCopy } from '@tabler/icons-react'
import { useState } from 'react'
import { Button } from './shadcn/button'

export const useCopy = () => {
  const [copied, setCopied] = useState(false)
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return { copied, copy }
}

export const CopyButton = ({
  text,
  label = 'Copy',
  variant = 'muted',
  size = 'sm',
}: {
  text: string
  label?: string
  variant?: 'muted' | 'ghost' | 'default' | 'primary'
  size?: 'sm' | 'xs' | 'default'
}) => {
  const { copied, copy } = useCopy()
  return (
    <Button type="button" variant={variant} size={size} onClick={() => void copy(text)} aria-live="polite">
      {copied ? <IconCheck /> : <IconCopy />}
      {copied ? 'Copied' : label}
    </Button>
  )
}
