import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))

// The helper types the shadcn-svelte registry components import from `$lib/utils.js`.
export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, 'child'> : T
export type WithoutChildren<T> = T extends { children?: unknown } ? Omit<T, 'children'> : T
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null }
