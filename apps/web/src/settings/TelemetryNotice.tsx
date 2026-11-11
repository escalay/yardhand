/**
 * Said once before the first usage report goes, for an instance that upgraded and never sees the setup again: what
 * is sent, when, and how to stop it. Dismissed for good in this browser; gone by itself once a report has gone.
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { telemetryQuery } from '@/shell/queries'
import { Mono } from '@/ui/Code'
import { Button } from '@/ui/shadcn/button'
import { TELEMETRY_ID } from './Telemetry'
import { OFF_LINE, waitsForFirst } from './telemetry.rules'

const DISMISSED = 'yardhand.telemetry.notice'
const wasDismissed = () => {
  try {
    return localStorage.getItem(DISMISSED) === 'dismissed'
  } catch {
    return false
  }
}
const rememberDismissal = () => {
  try {
    localStorage.setItem(DISMISSED, 'dismissed')
  } catch {}
}

export const TelemetryNotice = () => {
  const telemetry = useQuery(telemetryQuery)
  const [dismissed, setDismissed] = useState(wasDismissed)
  if (dismissed || !telemetry.data || !waitsForFirst(telemetry.data)) return null
  return (
    <aside
      aria-label="Usage telemetry"
      className="flex flex-wrap items-center justify-end gap-x-4 gap-y-3 border border-border bg-card px-5 py-3.5"
    >
      <p className="min-w-0 flex-1 basis-72 text-sm text-pretty">
        Yardhand sends one anonymous usage report a day: ranges and yes/no answers, no names or addresses. The first
        goes a day after this version first ran. <Mono>{OFF_LINE}</Mono> in .env, then a restart, stops it.
      </p>
      <div className="flex gap-2">
        <Button asChild variant="muted" size="sm">
          <Link to="/settings" hash={TELEMETRY_ID}>
            See the report
          </Link>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            rememberDismissal()
            setDismissed(true)
          }}
        >
          Dismiss
        </Button>
      </div>
    </aside>
  )
}
