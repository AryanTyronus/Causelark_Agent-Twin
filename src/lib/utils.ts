// @polsia:framework-owned — DO NOT EDIT. Code installed by polsia/template-next@0.3.0. Drift = commit rejected.
//
// shadcn standard cn() helper. Every shadcn primitive imports this.

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
