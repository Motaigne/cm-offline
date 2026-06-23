# ROADMAP optiP

Liste vivante des sujets ouverts. Mise à jour à chaque session — on coche, on ajoute, on déplace.

**Convention :**
- `[ ]` = à faire
- `[~]` = en cours
- `[x]` = fait (à archiver dans `sources/optiP_BILAN_*.md`)
- 🔴 bloquant · 🟠 important · 🟡 confort · 🔵 idée

## Règle de base (rappel non-négociable)

1. **Hors ligne** : la PWA doit fonctionner totalement hors ligne (sauf EP4 import).
2. **Esprit offline** : nouvelle feature → data hydratée via Dexie/cache, jamais fetch ad-hoc.
3. **Scrapping** : ~300 requêtes CrewBidd / mois max.
4. **Fluidité** : pas d'action user-facing > 1 s sans indicateur, jamais > 30 s même avec.

Toute nouvelle proposition doit cocher les 4 cases avant d'être codée.

---

## 🔴 Bloquants / risques connus

- [ ] **Conflits multi-device** — modifications offline simultanées sur 2 appareils : actuellement le dernier qui Push gagne, pas de merge ni d'alerte. À spec.
- [ ] **Wipe app bouton ne marche pas** (cause RLS, workaround SQL Studio). Origine session 2026-06-11 — vérifier si réglé par les migrations récentes.

## 🟠 Gantt & UX

- [ ] **Pager mois swipe horizontal façon iOS** (revert `6b2d9c7`). Specs détaillées dans `memory/project_session_20260618_ep4_stale.md` :
  - Pré-charge 4 mois adjacents (M → M+3)
  - Translate continu au doigt + snap final
  - Colonne paie FIXE hors du pager
  - Flèches ‹ › = saut de 4 mois
  - Si perf trop lourde sur iPad → abandonner, garder chevrons seuls.
- [ ] **Re-tester export/import planning** (disquette NavBar). Bug user signalé "il y a 3 jours" mais avant les gros refactos — peut-être déjà réglé.

## 🟠 Offline-first

- [x] **Pull différentiel par mois (skip si serveur inchangé)** — commit `ea33d48` (2026-06-23). Mig 0041 (`pairing_signature.updated_at` + trigger + backfill), action `getMonthsLastModified` (fenêtre {M-1, M} × 4 sources), table Dexie `month_sync_state` v11, `handlePull({force})`, long-press 800 ms = bypass. À valider sur iPad — 1er Pull = full, 2e = ~5s, après édit draft = +1 mois.
- [x] **POSTs offline non-gated** (2026-06-23). Audit : nav.tsx déjà 100% gaté depuis `a96acbb`. Le vrai non-gated était dans `useAuthGuard` → background `getUser()` polluait la console DevTools. Fix : early return `if (!navigator.onLine) return` au début de l'IIFE background. `pendingOpsCount` confirmé 100% local Dexie, pas un POST.
- [ ] **Audit `cache*` wipe-sur-timeout** sur les tables non encore traitées par `fdd1491` (profileVersions/AnnexeRows/A81Overrides/A81YearData OK ; lister les restantes).
- [ ] **Juillet absent du sync lite** — non reproductible facilement. À creuser quand revu.
- [ ] **Test wifi captif AF iPad réel** — le test ultime, jamais validé en conditions vol. Validé en simulation SIM travail uniquement.
- [ ] **Précacher chunk pdfjs** (~2 Mo) côté SW pour permettre l'import EP4 sur 1er PDF cold-cold offline. Aujourd'hui : import = online-only, consultation = offline.

## 🟠 EP4

- [ ] **Bug rescue serveur** : sig courante censée arriver via `d3b29a7` n'est pas en Dexie chez le user. Sync timeout ? mode planning_only ? SW stale ? Possiblement ajouter un log côté serveur visible client (header de réponse).
- [ ] **Cleanup Dexie orphelin** : une sig stale cachée sous `target_month=juillet` survit aux sync juin → multi-candidates dans `instCandidates`. Cleanup transversal à étudier (mais risqué).
- [ ] **Solution durable au skip `stale-instance`** : faire `buildEp4Rotation` shifter les legs par `(override.beginBlockMs - rawFirstLegMs)`. Garantit cohérence même si Dexie a `raw_detail` d'une autre occurrence. Risque : impacts cross-cas (HCV_mois_M, etc.) — test approfondi requis.
- [ ] **Sigs sans `raw_detail` côté serveur** (ex 4ON BZV) — re-scrape ciblé requis.
- [ ] **EP4 table complet offline** : seule la ligne Rotation s'affiche en EP4 sur SIM car `raw_detail` pas caché en Dexie (volontaire — ~50-200 kB/sig × 30-50 sigs/mois × N mois = plusieurs MB). Faisable mais non-trivial.
- [ ] **Refondre `Ep4FraisDeplacementConsolidee` / `HoraireConsolidee` / `DecompteConsolidee`** au format PDF panel (cohérence visuelle avec les tableaux refondus).

## 🟡 Petits chantiers

- [ ] **Bandeau MEP** : confirmer que `sig.dead_head` matche la sémantique "rotation contient au moins un leg MEP". Si user voit des faux positifs/négatifs, raffiner sur `raw_detail.pairings[*].flightDuties[*].activities[*].dead_head`.
- [ ] **Auth_log session_lost** : à surveiller le pattern de logs depuis le passage client-side (`source:'client'`).

## 🔵 Idées non-priorisées

- [ ] Notifications push (techniquement déjà câblées : `web-push` et `use-push-subscription` présents).
- [ ] Gestion réelle de conflits multi-device avec UI de résolution.
- [ ] Pre-cache du chunk pdfjs (lié au point offline plus haut).

---

## Pour les sessions futures (méta)

- **Avant de proposer une feature**, écrire explicitement la vérification REGLE DE BASE (cf. en-tête).
- **À chaque session terminée** : déplacer les items réalisés vers un nouveau `sources/optiP_BILAN_AAAAMMJJ.md`, mettre à jour MEMORY.md.
- **Pièges déjà rencontrés** sont consignés dans les `memory/project_session_*.md` — à relire au moindre doute sur un refacto SW/offline/EP4.
