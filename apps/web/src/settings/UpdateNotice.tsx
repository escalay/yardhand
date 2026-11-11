/** One quiet line on Home while a newer version waits: which one, its release notes, and the way to Settings. */
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { updatesQuery } from '@/shell/queries'
import { Button } from '@/ui/shadcn/button'
import { noticeOf, UPDATES_ID } from './updates.rules'

export const UpdateNotice = () => {
  const updates = useQuery(updatesQuery)
  const notice = updates.data ? noticeOf(updates.data) : null
  if (!notice) return null
  return (
    <aside
      aria-label="Update available"
      className="flex flex-wrap items-center justify-end gap-x-4 gap-y-3 border border-border bg-card px-5 py-3.5"
    >
      <p className="min-w-0 flex-1 basis-72 text-sm text-pretty">
        Yardhand {notice.version} is available; this is {notice.current}.{' '}
        <a href={notice.notes} target="_blank" rel="noreferrer" className="underline underline-offset-4">
          Release notes
        </a>
      </p>
      <Button asChild variant="muted" size="sm">
        <Link to="/settings" hash={UPDATES_ID}>
          See the update
        </Link>
      </Button>
    </aside>
  )
}
