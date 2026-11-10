/** Tools' parts: every tool, the changes waiting for review, and what every agent sees pinned. */
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { overviewQuery } from '@/shell/queries'
import { LineTabs, TabCount } from '@/ui/LineTabs'

export const ToolsTabs = ({ active }: { active: 'tools' | 'reviews' | 'pins' }) => {
  const overview = useQuery(overviewQuery)
  const pending = overview.data?.totals.pendingReviews ?? 0
  return (
    <LineTabs
      label="Tools"
      active={active}
      className="-mx-1 border-b border-border"
      tabs={[
        { id: 'tools', label: 'Tools', count: overview.data?.totals.tools || null },
        { id: 'reviews', label: 'Reviews', count: pending || null, dot: Boolean(pending) },
        { id: 'pins', label: 'Pins' },
      ]}
      render={(tab, props) =>
        tab.id === 'reviews' ? (
          <Link key={tab.id} to="/tools/reviews" {...props}>
            {tab.label}
            <TabCount tab={tab} />
          </Link>
        ) : (
          <Link key={tab.id} to="/tools" search={tab.id === 'pins' ? { pinned: true } : {}} {...props}>
            {tab.label}
            <TabCount tab={tab} />
          </Link>
        )
      }
    />
  )
}
