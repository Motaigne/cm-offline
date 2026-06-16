'use client';

// Coquille statique précachée par le service worker. Aucun fetch serveur au
// boot — toutes les data viennent de Dexie via `GanttShellClient`. Permet à
// l'app de démarrer instantanément hors ligne et sur WiFi captif (le SW sert
// l'HTML statique sans jamais toucher le réseau).
//
// Les types CalendarItem/Scenario restent exportés ici parce que pas mal de
// modules (server actions, lib/, components) les importent depuis `@/app/page`.
// Les types sont effacés au build → l'import marche aussi côté serveur.

import { Suspense } from 'react';
import { GanttShellClient } from '@/app/components/gantt/gantt-shell-client';
import type { Json } from '@/types/supabase';
import type { ActivityKind, BidCategory } from '@/lib/activity-meta';
import type { ScenarioName } from '@/app/actions/planning';

export type CalendarItem = {
  id: string;
  kind: ActivityKind;
  start_date: string;
  end_date: string;
  bid_category: BidCategory | null;
  /** Référence vers pairing_instance — requis pour EP4 / IR-MF / Article 81. */
  pairing_instance_id?: string | null;
  meta: Json | null;
  /** Flag runtime (non persisté) — item issu de M-1 injecté en M.
   *  Couvre les 3 sous-cas via `_rpcOnlySpillover` / `_isPauseSpillover`. */
  _isSpillover?: boolean;
  /** Sous-cas : vol dont le CORPS reste en M-1 mais dont le RPC étendu
   *  (mode chevauchement) atteint M. clipItem renvoie un clip synthétique
   *  { start:1, end:1 } pour permettre à DraggableBar de rendre la queue
   *  post-RPC ; le corps et le pré-repos sont sautés. */
  _rpcOnlySpillover?: boolean;
  /** Sous-cas : congé/TAF/CSS/hard-blocker de M-1 inclus dans `scenario.items`
   *  UNIQUEMENT pour que `computeEffectiveRpc` puisse calculer correctement
   *  les pauses des vols spillover. Jamais rendu, jamais validé. */
  _isPauseSpillover?: boolean;
};

export type Scenario = {
  name: ScenarioName;
  id: string;
  items: CalendarItem[];
};

function ShellFallback() {
  return (
    <main className="flex-1 flex items-center justify-center p-8 text-sm text-zinc-400">
      Chargement…
    </main>
  );
}

export default function Home() {
  // Suspense requis parce que GanttShellClient appelle useSearchParams.
  return (
    <Suspense fallback={<ShellFallback />}>
      <GanttShellClient />
    </Suspense>
  );
}
