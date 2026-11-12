import { AlertTriangle, CheckCircle2, HelpCircle } from 'lucide-react';
import type { ConfidenceLevel } from '../types';

interface ConfidenceBadgeProps {
  level: ConfidenceLevel;
}

export function ConfidenceBadge({ level }: ConfidenceBadgeProps) {
  if (level === 'high') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-900 dark:bg-emerald-950/80 dark:text-emerald-200 whitespace-nowrap shrink-0">
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
        High confidence
      </span>
    );
  }

  if (level === 'medium') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900 dark:bg-amber-950/70 dark:text-amber-200 whitespace-nowrap shrink-0">
        <HelpCircle className="h-3.5 w-3.5 text-amber-700 dark:text-amber-400" aria-hidden="true" />
        Medium confidence
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-900 dark:bg-rose-950/70 dark:text-rose-200 whitespace-nowrap shrink-0">
      <AlertTriangle className="h-3.5 w-3.5 text-rose-700 dark:text-rose-400" aria-hidden="true" />
      Low confidence
    </span>
  );
}
