import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getScenariosWithItems } from '@/app/actions/planning';
import { listNotesForMonth } from '@/app/actions/notes';
import { loadAnnexeForMonth, loadAnnexeRowForMonth, loadAllAnnexeRows } from '@/app/actions/annexe';
import { loadProfileForMonth, loadAllProfileVersions } from '@/app/actions/profile-version';
import { getYearA81CumulBefore } from '@/app/actions/article81';
import { getMonthlyIrMfEuros } from '@/app/actions/ir-mf';
import { GanttView } from '@/app/components/gantt/gantt-view';
import { computeFullProfile, type AnnexeData } from '@/lib/annexe';
import { REGIME_NB30E } from '@/lib/finance';
import type { Article81Data } from '@/lib/article81';
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

  const { data: userProfile } = await supabase
    .from('user_profile')
    .select('*')
    .eq('user_id', user.id)
    .single();
  if (!userProfile) redirect('/profil');

  const [y, mo] = month.split('-').map(Number);
  const [scenarios, notes, annexe, allAnnexeRows, profileForMonth, profileVersions,
         a81RowData, a81Cumul, irMfMonth, prorataRowData, ddaRulesRowData, volPRulesRowData,
         fictiveSnapsRaw] = await Promise.all([
    getScenariosWithItems(month),
    listNotesForMonth(month),
    loadAnnexeForMonth(month),
    loadAllAnnexeRows(),
    loadProfileForMonth(month, user.id),
    loadAllProfileVersions(user.id),
    loadAnnexeRowForMonth('article_81', month),
    getYearA81CumulBefore(y, mo),
    getMonthlyIrMfEuros(month),
    loadAnnexeRowForMonth('prorata', month),
    loadAnnexeRowForMonth('dda_rules', month),
    loadAnnexeRowForMonth('vol_p_rules', month),
    // Liste des mois fictifs (projection admin) — pour banner + coloration cellules.
    supabase
      .from('scrape_snapshot')
      .select('target_month')
      .eq('is_fictive', true)
      .eq('status', 'success'),
  ]);
  const fictiveMonths: string[] = (fictiveSnapsRaw?.data ?? []).map(r => (r.target_month as string).slice(0, 7));
  // Profil applicable au mois M (fallback user_profile pour les mois antérieurs
  // à la première version seedée, ou pendant la transition).
  const profile = profileForMonth ?? userProfile;
  const ddaRulesData   = (ddaRulesRowData  as { rules: unknown[] } | null) ?? null;
  const volPRulesData  = (volPRulesRowData as { rules: unknown[] } | null) ?? null;
  type ProrataThreshold = { range: string; ji_restants: number; duree_min: number; duree_min_opt6: number };
  const prorataThresholds: ProrataThreshold[] =
    (prorataRowData as { thresholds: ProrataThreshold[] } | null)?.thresholds ?? [];
  const article81Data: Article81Data | null = (a81RowData as Article81Data | null) ?? null;
  const valeurJour = Number(profile.valeur_jour ?? 600);

  // Calcul des primes mensuelles fixes (incitation + A330 + instruction) +
  // éléments de paie versionnés (pvei, fixe, fixeTP, ksp) qui pilotent le
  // calendrier. `fixe` = fixe régime (proratisé nb30e), `fixeTP` = fixe TP
  // (utilisé en jul/août pour TAF*_10_12 quand full-prime).
  const finBase = (() => {
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

  return (
    <GanttView
      month={month}
      scenarios={scenarios}
      userName={userProfile.display_name ?? user.email ?? ''}
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
      annexeRows={allAnnexeRows}
      profileVersions={profileVersions}
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
      article81Data={article81Data}
      valeurJour={valeurJour}
      a81CumulBefore={a81Cumul.byScenarioBefore}
      irMfByScenario={irMfMonth.byScenario}
      irMfPerFlightByScenario={irMfMonth.perFlightByScenario}
      prorataThresholds={prorataThresholds}
      transport={profile.transport}
      navigoEur={Number(profile.navigo_eur ?? 0)}
      voitureKmAller={Number(profile.voiture_km_aller ?? 0)}
      voitureIndemniteKm={Number(profile.voiture_indemnite_km ?? 0)}
      ddaRulesData={ddaRulesData}
      volPRulesData={volPRulesData}
      notes={notes}
      fictiveMonths={fictiveMonths}
    />
  );
}
