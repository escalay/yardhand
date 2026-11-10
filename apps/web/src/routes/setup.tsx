import { createFileRoute } from '@tanstack/react-router'
import { SetupPage } from '@/setup/SetupPage'
import { isStep, type StepId } from '@/setup/setup.rules'

const Setup = () => <SetupPage step={Route.useSearch().step} />

export const Route = createFileRoute('/setup')({
  validateSearch: (search: Record<string, unknown>): { step?: StepId } =>
    isStep(search.step) ? { step: search.step } : {},
  component: Setup,
})
