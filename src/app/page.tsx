import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getScenariosWithItems } from '@/app/actions/planning';
import { loadAnnexe } from '@/app/actions/annexe';
import { GanttView } from '@/app/components/gantt/gantt-view';
import { computeFullProfile, type AnnexeData } from '@/lib/annexe';
import { REGIME_NB30E } from '@/lib/finance';
import type { ActivityKind, BidCategory } from '@/lib/activity-meta';
import type { ScenarioName } from '@/app/actions/planning';

export type CalendarItem = {
  id: string;
  kind: ActivityKind;
  start_date: string;
  end_date: string;
  bid_category: BidCategory | null;
  meta: import('@/types/supabase').Json | null;
  /** Flag runtime (non persisté) — vol à cheval issu du mois précédent. */
  _isSpillover?: boolean;
};

export type Scenario = {
  name: ScenarioName;
  id: string;
  items: CalendarItem[];
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const { m } = await searchParams;
  const month = m && /^\d{4}-\d{2}$/.test(m)
    ? m
    : new Date().toISOString().slice(0, 7);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('user_profile')
    .select('*')
    .eq('user_id', user.id)
    .single();
  if (!profile) redirect('/profil');

  const [scenarios, annexe] = await Promise.all([
    getScenariosWithItems(month),
    loadAnnexe(),
  ]);

  // Calcul des primes mensuelles fixes (incitation + A330 + instruction).
  // - primeIncitationUnit : montant pour 1 prime (le calendrier multiplie par
  //   le compteur 0–5 saisi dans la barre du bas).
  // - primeA330 / primeInstruction : valeurs déjà proratisées au régime
  //   (nb30e_regime / 30). Indépendantes du compteur d'incitation.
  // Hors prime bi-tronçon (sommée par vol) et hors Prime Mai (lot séparé).
  const primes = (() => {
    const hasAnnexe = !!(
      annexe.cat_anciennete?.length &&
      annexe.coef_classe?.length &&
      annexe.taux_avion?.length &&
      annexe.traitement_base
    );
    if (!hasAnnexe || !profile.fonction || !profile.classe || !profile.echelon || !profile.categorie) {
      return { primeIncitationUnit: 0, primeA330: 0, primeInstruction: 0 };
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
    };
  })();

  return (
    <GanttView
      month={month}
      scenarios={scenarios}
      userName={profile.display_name ?? user.email ?? ''}
      userRegime={profile.regime}
      cngPv={profile.cng_pv ?? 0}
      cngHs={profile.cng_hs ?? 0}
      primeIncitationUnit={primes.primeIncitationUnit}
      primeA330={primes.primeA330}
      primeInstruction={primes.primeInstruction}
    />
  );
}
