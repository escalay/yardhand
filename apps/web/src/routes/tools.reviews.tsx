import { createFileRoute } from '@tanstack/react-router'
import { ReviewsPage } from '@/reviews/ReviewsPage'

export const Route = createFileRoute('/tools/reviews')({ component: ReviewsPage })
