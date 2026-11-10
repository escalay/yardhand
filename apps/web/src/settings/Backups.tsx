/**
 * The kept copies of the database: download one, make one now, or restore the gateway from one (a kept copy, or a
 * file from another instance). A restore is checked first and asks before it replaces anything; the gateway then
 * restarts, and this page waits for it.
 */
import { IconDownload, IconUpload } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api, type Schemas, unwrap } from '@/api/client'
import { ago, bytes } from '@/ui/format'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/shadcn/alert-dialog'
import { Button } from '@/ui/shadcn/button'
import { backupKind, holdsLine } from './jobs.rules'
import { SettingsCard } from './SettingsGroup'

type Backup = Schemas['System']['backups'][number]
type Restore = Schemas['Restore']
/** A kept backup by its name, or a file the owner picked. */
type Source = { file: string } | { upload: File }

const SQLITE = 'application/vnd.sqlite3'
const nameOf = (source: Source) => ('file' in source ? source.file : source.upload.name)

const restoreFrom = (source: Source, query: { dryRun?: 'true'; force?: 'true' }) =>
  'file' in source
    ? unwrap(api.POST('/api/system/backups/{file}/restores', { params: { path: { file: source.file }, query } }))
    : unwrap(
        api.POST('/api/system/restores', {
          params: { query },
          body: source.upload as unknown as string,
          bodySerializer: (body) => body,
          headers: { 'content-type': SQLITE },
        }),
      )

/** Shown while the gateway restarts: reloads the page once it answers again. */
const Restarting = () => {
  useEffect(() => {
    let down = false
    const timer = setInterval(() => {
      void fetch('/api/health', { cache: 'no-store' }).then(
        (response) => {
          if (response.ok && down) window.location.reload()
          if (!response.ok) down = true
        },
        () => {
          down = true
        },
      )
    }, 2000)
    // A restart too quick to catch still ends in a reload
    const fallback = setTimeout(() => window.location.reload(), 45_000)
    return () => {
      clearInterval(timer)
      clearTimeout(fallback)
    }
  }, [])
  return (
    <SettingsCard>
      <p className="px-5 py-4 text-sm">
        Restoring: Yardhand is restarting with the restored data. This page reloads when it is back, in about half a
        minute.
      </p>
    </SettingsCard>
  )
}

export const Backups = ({ backups }: { backups: Backup[] }) => {
  const queries = useQueryClient()
  const picker = useRef<HTMLInputElement>(null)
  const [asked, setAsked] = useState<{ source: Source; holds: Restore } | null>(null)
  const [restarting, setRestarting] = useState(false)
  const backUp = useMutation({
    mutationFn: () => unwrap(api.POST('/api/system/jobs/{name}/runs', { params: { path: { name: 'backup' } } })),
    onSuccess: (system) => {
      queries.setQueryData(['system'], system)
      const run = system.jobs.find((job) => job.name === 'backup')
      if (run?.ok) toast.success(run.detail ?? 'Backed up.')
      else toast.error(run?.detail ?? 'The backup failed: the server log has why.')
    },
    onError: (error) => toast.error(error.message),
  })
  // Checked first, so the question names what the file holds
  const check = useMutation({
    mutationFn: async (source: Source) => ({ source, holds: await restoreFrom(source, { dryRun: 'true' }) }),
    onSuccess: setAsked,
    onError: (error) => toast.error(error.message),
  })
  const restore = useMutation({
    mutationFn: ({ source, holds }: { source: Source; holds: Restore }) =>
      restoreFrom(source, holds.secrets === 'unreadable' ? { force: 'true' } : {}),
    onSuccess: (result) => {
      setAsked(null)
      if (result.restart === 'now') setRestarting(true)
      else toast.success(`Staged. Restart Yardhand to finish; today’s data is kept as ${result.kept}.`)
    },
    onError: (error) => toast.error(error.message),
  })
  if (restarting) return <Restarting />
  return (
    <>
      <SettingsCard>
        {backups.length ? (
          backups.map((backup) => (
            <div key={backup.file} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-mono text-[13px]">{backup.file}</span>
                <span className="text-xs text-muted-foreground">
                  {backupKind(backup.file)}, {ago(backup.at)}, {bytes(backup.bytes)}
                </span>
              </div>
              <div className="flex gap-2">
                <Button asChild size="sm" variant="ghost">
                  <a href={`/api/system/backups/${backup.file}`} download={backup.file}>
                    <IconDownload /> Download
                  </a>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={check.isPending}
                  aria-label={`Restore ${backup.file}`}
                  onClick={() => check.mutate({ file: backup.file })}
                >
                  Restore
                </Button>
              </div>
            </div>
          ))
        ) : (
          <p className="px-5 py-4 text-sm text-muted-foreground">
            None yet. The first is made within a day of the start.
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-muted/40 px-5 py-3">
          <span className="max-w-md text-xs text-pretty text-muted-foreground">
            A backup holds everything. Keys in it stay sealed: another instance reads them only with the same
            GATEWAY_MASTER_KEY.
          </span>
          <span className="flex gap-2">
            <input
              ref={picker}
              type="file"
              accept=".sqlite,.db,application/vnd.sqlite3"
              className="hidden"
              aria-label="A backup file to restore from"
              onChange={(event) => {
                const upload = event.target.files?.[0]
                if (upload) check.mutate({ upload })
                event.target.value = ''
              }}
            />
            <Button size="sm" variant="ghost" disabled={check.isPending} onClick={() => picker.current?.click()}>
              <IconUpload /> Restore from a file
            </Button>
            <Button size="sm" variant="muted" disabled={backUp.isPending} onClick={() => backUp.mutate()}>
              {backUp.isPending ? 'Backing up…' : 'Back up now'}
            </Button>
          </span>
        </div>
      </SettingsCard>
      <AlertDialog open={Boolean(asked)} onOpenChange={(open) => (open ? null : setAsked(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore from {asked ? nameOf(asked.source) : ''}?</AlertDialogTitle>
            <AlertDialogDescription>
              {asked ? holdsLine(asked.holds) : ''} Restoring replaces everything here with it: connections, tools,
              agents and their keys, packs and the call log. Today’s data is kept as a backup first, so you can go back.
              Yardhand restarts, and agents are cut off for about half a minute.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {asked?.holds.secrets === 'unreadable' ? (
            <p className="border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
              Its keys were sealed under another master key, so this gateway can’t read them: every connection that
              signs in will need its key again. To keep them, start this gateway with that instance’s GATEWAY_MASTER_KEY
              and restore then.
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep what there is</AlertDialogCancel>
            <AlertDialogAction
              variant="danger"
              disabled={restore.isPending}
              onClick={(event) => {
                event.preventDefault()
                if (asked) restore.mutate(asked)
              }}
            >
              {restore.isPending
                ? 'Restoring…'
                : asked?.holds.secrets === 'unreadable'
                  ? 'Restore without its keys'
                  : 'Restore and restart'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
