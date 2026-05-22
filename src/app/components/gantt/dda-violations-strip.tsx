'use client';

import { useState } from 'react';
import type { Violation, DdaCategory } from '@/lib/dda-validator';

const CAT_SHORT: Record<DdaCategory, string> = {
  DDA_REPOS:   'DDA REPOS',
  DDA_VOL:     'DDA VOL',
  VOL_P:       'VOL P',
  CONGES:      'CONGES',
  ELABO_SUIVI: 'Élabo/Suivi',
};

function fmtFr(dateStr: string): string {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

export function DdaViolationsStrip({
  violations,
  onAcceptRpcReport,
}: {
  violations: Violation[];
  onAcceptRpcReport: (flightItemId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const n = violations.length;

  return (
    <div className="flex-shrink-0 border-t border-amber-200 dark:border-amber-900/40 bg-amber-50/70 dark:bg-amber-950/20">
      {/* Header / résumé */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-amber-100/50 dark:hover:bg-amber-900/20 transition-colors"
      >
        <span className="text-amber-600 dark:text-amber-400 text-[14px] leading-none">⚑</span>
        <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-300 uppercase tracking-wide">
          {n} violation{n > 1 ? 's' : ''} DDA
        </span>
        <span className="text-[10px] text-amber-600/70 dark:text-amber-400/70">
          {violations.slice(0, 3).map(v => v.scenario_name).join(', ')}
          {n > 3 ? ` +${n - 3}` : ''}
        </span>
        <span className="ml-auto text-[10px] text-amber-600 dark:text-amber-400">
          {expanded ? '▾ Replier' : '▸ Détails'}
        </span>
      </button>

      {/* Liste détaillée */}
      {expanded && (
        <div className="max-h-40 overflow-y-auto border-t border-amber-200/60 dark:border-amber-900/30 divide-y divide-amber-100 dark:divide-amber-900/30">
          {violations.map((v, i) => (
            <div key={`${v.item_a_id}-${v.item_b_id}-${i}`} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
              <span className="font-bold text-zinc-700 dark:text-zinc-200 w-4 flex-shrink-0">{v.scenario_name}</span>
              <span className="text-zinc-500 dark:text-zinc-400 flex-shrink-0">
                {fmtFr(v.pivot_date)}
              </span>
              <span className="text-zinc-700 dark:text-zinc-200">
                {CAT_SHORT[v.cat_a]} → {CAT_SHORT[v.cat_b]}
                {v.rpc_days != null && (
                  <span className="text-zinc-400 ml-1">RPC {v.rpc_days}j</span>
                )}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-950/50 text-red-600 dark:text-red-400 font-mono font-semibold">
                gap {v.gap_days}j
              </span>
              {v.can_accept_rpc_report && (
                <button
                  onClick={() => onAcceptRpcReport(v.item_a_id)}
                  className="ml-auto px-2 py-1 rounded-md border border-amber-300 dark:border-amber-700 bg-white dark:bg-zinc-900 text-amber-700 dark:text-amber-300 text-[10px] font-semibold hover:bg-amber-50 dark:hover:bg-amber-900/30 transition-colors"
                  title="Acquitter la violation en reportant le RPC à la fin des CONGES"
                >
                  Reporter RPC
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
