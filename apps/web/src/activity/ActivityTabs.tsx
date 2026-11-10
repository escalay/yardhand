/** Activity's parts: every call, the searches agents made, and the calls that didn't work. */
import { Link } from '@tanstack/react-router'
import { LineTabs } from '@/ui/LineTabs'

export const ActivityTabs = ({ active }: { active: 'calls' | 'searches' | 'problems' }) => (
  <div className="flex flex-col gap-3">
    <header className="flex flex-col gap-1">
      <span className="text-xs tracking-wide text-muted-foreground uppercase">{'/// '}Activity</span>
      <h1 className="text-3xl tracking-tight sm:text-4xl">
        {active === 'searches' ? (
          <>
            What agents <em>looked for</em>
          </>
        ) : (
          <>
            Every call, <em>as it happens</em>
          </>
        )}
      </h1>
    </header>
    <LineTabs
      label="Activity"
      active={active}
      className="-mx-1 border-b border-border"
      tabs={[
        { id: 'calls', label: 'Calls' },
        { id: 'searches', label: 'Searches' },
        { id: 'problems', label: "Didn't work" },
      ]}
      render={(tab, props) =>
        tab.id === 'searches' ? (
          <Link key={tab.id} to="/activity/searches" {...props}>
            {tab.label}
          </Link>
        ) : (
          <Link
            key={tab.id}
            to="/activity"
            search={
              ((previous: Record<string, unknown>) => ({
                ...previous,
                outcome: tab.id === 'problems' ? 'problems' : 'all',
                call: undefined,
              })) as never
            }
            {...props}
          >
            {tab.label}
          </Link>
        )
      }
    />
  </div>
)
