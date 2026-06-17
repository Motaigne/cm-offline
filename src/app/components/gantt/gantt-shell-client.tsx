'use client';

// Pendant client de l'ancien Server Component `/page.tsx`. Lit Dexie au lieu
// de Supabase. Permet à `/` d'être servie comme une coquille statique précachée
// par le service worker — donc immédiate hors ligne / sur wifi captif.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthGuard } from '@/hooks/use-auth-guard';
import { loadShellData, type ShellData } from '@/lib/shell-data';
import { GanttView } from '@/app/components/gantt/gantt-view';
import { computeFullProfile, type AnnexeData } from '@/lib/annexe';
import { REGIME_NB30E } from '@/lib/finance';
import { getScenariosWithItems } from '@/app/actions/planning';
import { hydrateDB } from '@/lib/local-db';

function monthFromParam(raw: string | null): string {
  return raw && /^\d{4}-\d{2}$/.test(raw) ? raw : new Date().toISOString().slice(0, 7);
}

/** Lit `?m=YYYY-MM` une seule fois au mount. NON réactif aux changements
 *  d'URL via `window.history.replaceState` (utilisé par changeMonth dans
 *  gantt-view pour ne PAS déclencher de re-fetch shell à chaque navigation
 *  inter-mois). En cas de navigation Next.js réelle (Link → /), le shell
 *  se remonte de toute façon, donc la valeur est relue. */
function useInitialMonth(): string {
  const [month] = useState(() => {
    if (typeof window === 'undefined') return new Date().toISOString().slice(0, 7);
    const url = new URL(window.location.href);
    return monthFromParam(url.searchParams.get('m'));
  });
  return month;
}

function SkeletonShell({ stuck, onReload }: { stuck?: boolean; onReload?: () => void }) {
  return (
    <main className="flex-1 flex flex-col items-center justify-center p-8 gap-3 text-sm text-zinc-400">
      <span>Chargement…</span>
      {stuck && onReload && (
        <button
          onClick={onReload}
          className="mt-2 px-4 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          Bloqué ? Recharger
        </button>
      )}
    </main>
  );
}

export function GanttShellClient() {
  const router  = useRouter();
  const month   = useInitialMonth();
  const { status, session } = useAuthGuard();
  const [data, setData] = useState<ShellData | null>(null);
  const [noProfile, setNoProfile] = useState(false);
  const [stuck, setStuck] = useState(false);

  // Watchdog : si SkeletonShell visible >7s, propose un bouton "Recharger".
  // Permet à l'utilisateur de sortir d'un hang inexpliqué (ex iOS Safari
  // freeze post-idle qui empêche getSession / Dexie de progresser).
  useEffect(() => {
    if (data) return;
    const t = setTimeout(() => setStuck(true), 7000);
    return () => clearTimeout(t);
  }, [data]);

  useEffect(() => {
    if (status !== 'authed') return;
    let cancelled = false;
    void (async () => {
      try {
        console.warn('[shell] loadShellData start', month);
        const t0 = performance.now();
        let d = await loadShellData(month);
        const tShellDone = performance.now() - t0;
        console.warn(`[shell] loadShellData done ${Math.round(tShellDone)}ms`);
        if (cancelled) return;

        // Bridge de l'ancien comportement SSR : l'ancien `/page.tsx` Server
        // Component appelait getScenariosWithItems(month) qui auto-créait les
        // drafts A/B/C via getOrCreateScenarios. Sans ça, un user qui n'a
        // jamais visité ce mois voit un calendrier vide même en ligne. On
        // déclenche le fetch côté client si Dexie est vide ET online.
        // Hors ligne : on laisse vide, l'utilisateur verra l'EmptyCacheBanner
        // (si toute la base est vide) ou pourra naviguer vers un mois qu'il a
        // déjà visité.
        if (d.scenarios.length === 0 && navigator.onLine) {
          // Timeout 5s — sur wifi captif / SIM filtrée, navigator.onLine = true
          // mais le fetch hang indéfiniment. Sans timeout, le shell resterait
          // bloqué en "Chargement…". On laisse tomber, l'utilisateur verra le
          // calendrier vide (mieux qu'un écran blanc).
          try {
            const scs = await Promise.race([
              getScenariosWithItems(month),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('auto-fetch timeout')), 5000)),
            ]);
            if (cancelled) return;
            await hydrateDB(scs, month);
            d = await loadShellData(month);
            if (cancelled) return;
          } catch (err) {
            console.warn('[shell] auto-create drafts failed', err);
          }
        }

        if (!d.profile) {
          // Aucune version de profil locale — on tente le path online /profil.
          // Si offline, /profil échouera côté serveur et l'utilisateur verra le
          // fallback /offline + EmptyCacheBanner pour restore une sauvegarde.
          setNoProfile(true);
          router.replace('/profil');
          return;
        }
        const tBeforeSet = performance.now() - t0;
        console.warn(`[shell] setData called ${Math.round(tBeforeSet)}ms`);
        setData(d);
        // Mesure le delai jusqu'au prochain frame paint (= apres render React).
        // Si tFramePaint - tBeforeSet est gros (1-2s), le bottleneck est le
        // render synchrone de GanttView (matrice + computeStatsForScenario).
        requestAnimationFrame(() => {
          const tFramePaint = performance.now() - t0;
          console.warn(`[shell] first paint after setData ${Math.round(tFramePaint)}ms (render: +${Math.round(tFramePaint - tBeforeSet)}ms)`);
        });
      } catch (e) {
        console.error('[shell] loadShellData failed', e);
      }
    })();
    return () => { cancelled = true; };
  }, [status, month, router]);

  const reload = () => window.location.reload();
  if (status === 'loading' || status === 'redirecting') return <SkeletonShell stuck={stuck} onReload={reload} />;
  if (noProfile) return <SkeletonShell stuck={stuck} onReload={reload} />;
  if (!data) return <SkeletonShell stuck={stuck} onReload={reload} />;
  const profile = data.profile!;
  // session peut être null si useAuthGuard a timeouté en lisant les cookies
  // (cf wifi off + token close à expiration). Shell render quand même : le
  // background getUser revalidera et redirigera /login si vraiment plus authed.

  // finBase = primes mensuelles fixes (incitation + A330 + instruction) +
  // éléments versionnés (pvei, fixe, fixeTP, ksp). Mêmes règles que l'ancien
  // page.tsx, juste calculé client-side depuis l'annexe Dexie.
  const finBase = (() => {
    const annexe = data.annexe;
    const hasAnnexe = !!(
      annexe.cat_anciennete?.length &&
      annexe.coef_classe?.length &&
      annexe.taux_avion?.length &&
      annexe.traitement_base
    );
    if (!hasAnnexe || !profile.fonction || !profile.classe || !profile.echelon || !profile.categorie) {
      return { primeIncitationUnit: 0, primeA330: 0, primeInstruction: 0, pvei: null, ksp: null, fixe: null, fixeTP: null };
    }
    const isTri = profile.fonction === 'TRI_OPL' || profile.fonction === 'TRI_CDB';
    const primeInstFonction = profile.fonction === 'TRI_OPL' ? 'TRI_OPL'
      : profile.fonction === 'TRI_CDB' ? 'ICPL'
      : null;
    const nb30e = REGIME_NB30E[profile.regime] ?? 30;
    const c = computeFullProfile(
      profile.aircraft_principal ?? 'A335',
      profile.fonction,
      profile.classe,
      profile.categorie,
      profile.echelon,
      profile.bonus_atpl ?? false,
      nb30e,
      'LC',
      primeInstFonction,
      isTri ? profile.tri_niveau : null,
      profile.prime_330_count ?? null,
      annexe as AnnexeData,
    );
    return {
      primeIncitationUnit: c.primeIncitation,
      primeA330:           c.primeA330,
      primeInstruction:    c.primeInstruction,
      pvei:                c.pvei,
      ksp:                 c.ksp,
      fixe:                c.fixe,
      fixeTP:              c.fixeTP,
    };
  })();

  const valeurJour = Number(profile.valeur_jour ?? 600);
  const userName = session?.user.email ?? '';

  return (
    <GanttView
      month={month}
      scenarios={data.scenarios}
      userName={userName}
      userRegime={profile.regime}
      cngPv={profile.cng_pv ?? 0}
      cngHs={profile.cng_hs ?? 0}
      primeIncitationUnit={finBase.primeIncitationUnit}
      primeA330={finBase.primeA330}
      primeInstruction={finBase.primeInstruction}
      pvei={finBase.pvei ?? undefined}
      ksp={finBase.ksp ?? undefined}
      fixeRegime={finBase.fixe ?? undefined}
      fixeTP={finBase.fixeTP ?? undefined}
      annexeRows={data.annexeRows}
      profileVersions={data.profileVersions}
      financeProfile={
        profile.fonction && profile.classe != null && profile.categorie && profile.echelon != null
          ? {
              aircraft: profile.aircraft_principal ?? 'A335',
              fonction: profile.fonction,
              classe: profile.classe,
              categorie: profile.categorie,
              echelon: profile.echelon,
              atpl: profile.bonus_atpl ?? false,
              primeIncitationType: 'LC' as const,
              primeInstFonction: profile.fonction === 'TRI_OPL' ? 'TRI_OPL'
                : profile.fonction === 'TRI_CDB' ? 'ICPL'
                : null,
              primeInstAnnee: (profile.fonction === 'TRI_OPL' || profile.fonction === 'TRI_CDB') ? profile.tri_niveau : null,
              prime330Count: profile.prime_330_count ?? null,
            }
          : null
      }
      article81Data={data.article81Data}
      valeurJour={valeurJour}
      a81CumulBefore={data.a81CumulBefore}
      irMfByScenario={data.irMfByScenario}
      irMfPerFlightByScenario={data.irMfPerFlightByScenario}
      prorataThresholds={data.prorataThresholds}
      transport={profile.transport}
      navigoEur={Number(profile.navigo_eur ?? 0)}
      voitureKmAller={Number(profile.voiture_km_aller ?? 0)}
      voitureIndemniteKm={Number(profile.voiture_indemnite_km ?? 0)}
      ddaRulesData={data.ddaRulesData}
      volPRulesData={data.volPRulesData}
      notes={data.notes}
      fictiveMonths={data.fictiveMonths}
    />
  );
}
