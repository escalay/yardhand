import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Class names joined, later Tailwind classes winning over earlier ones. */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))
