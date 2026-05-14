# Formules — OptiP

> **Utilisation** : ce fichier est la référence unique des formules implémentées.  
> Colonnes : **Terme EP4** (feuilles officielles) | **Mon terme** (code TS) | **Définition** | **Formule EP4** | **Formule implémentée**  
> `⚠` = formule à confirmer / différence connue entre EP4 et implémentation.

---

## 1. Constantes globales

| Terme EP4 | Mon terme | Définition | Valeur |
|-----------|-----------|------------|--------|
| PVEI | `PVEI` | Taux avion x (Bonus ATPL + Coef. CLasse) x Catégorie d'ancienneté | **112,70 €/h** (ce n'est pas une constante) | 
| KSP | `KSP` | Coefficient valorisation avion LC | **1,07** |
| Traitement fixe | `FIXE_MENSUEL` | Traitement mensuel fixe x CoefficientFonction x Echelon x nb30e / 30 | **1 826,66 €** (ce n'est pas une constante) |
| Prime bi tronçon | `PRIME_BITRONCON` | 2,5 × PVEI | **281,75 €** (ce n'est pas une constante)|


---

## 2. Paie mensuelle (colonne Gantt)

### 2a. Paramètres d'entrée proratisés

| — | Mon terme | Définition | Formule implémentée |
|---|-----------|------------|---------------------|
| — | `nb30eEff` | 30e effectifs après congés | `nb30eRégime − congeDays` (min 0) |
| — | `fullPrime` | Mois "temps plein" (juillet/août, TAF*_10_12) | `true` si TAF7/10_10_12 et mois ∈ {7,8} |
| — | `nb30eForFin` | 30e utilisés pour les calculs financiers | `fullPrime ? 30 : nb30eEff` |
| — | `fixeForFin` | Fixe mensuel effectif | `fullPrime ? FIXE_MENSUEL × 30/nb30eRégime : FIXE_MENSUEL` |

> **En juillet/août pour TAF\*_10_12** : le pilote est traité "temps plein" (pas de TAF) — FIXE et MGA basculent sur la base 30/30. La variable `tafOk` (dispo TAF) est `false` pour ces mois-là. ???Et si on utilise ma nouvelle défnition de Fixe???

### 2b. Formules de paie

| Terme EP4 | Mon terme | Définition | Formule EP4 | Formule implémentée |
|-----------|-----------|------------|-------------|---------------------|
| Heures de paie vol | `totalPv` | Heures valorisées (HCr + nuit) | HC × coefficients | `Σ(HCr_crew) + Σ(TSVnuit)/2` *(HCr proratisé sur le mois M pour les vols à cheval)* |
| PV € | `pvEur` | Montant paie vol | PV × PVEI × KSP | `totalPv × PVEI × KSP` |
| HC brut | `totalHc` | HC brut (pas HCr, pas proratisé) | — | `Σ(hc)` *(utilisé uniquement pour taux moyen HS ET pour le calcul de hsH)* |
| FIXE | `fin.fixe` | Traitement fixe mensuel | — | `fixeForFin` |
| MGA | `mga` | Minimum garanti d'activité | `(FIXE + 85×PVEI) × 30e` | `fixeForFin + 85 × (nb30eForFin/30) × PVEI` | *quid de la nouvelle définiton de Nombre de 30e par régime en fin de doc ?* 
| DIF | `fin.dif` | Complément jusqu'au MGA | `max(0, MGA − (FIXE+PV€+congeAmount))` | `max(0, mga − (fixeForFin + pvEur + congeAmount))` |
| Seuil HS | `hsSeuil` | Seuil déclenchement HS | 75h × 30e/30 | `75 × (nb30eForFin/30)` |
| HS (heures) | `hsH` | Heures supplémentaires | `max(0, totalHc − seuil75)` | `max(0, totalHc − hsSeuil)` | 
| HS.FIXE | `hsFixeRate` | Taux HS composante fixe (par heure) | — | `fixeForFin × 1,25 / 75` |
| HS.VOL | `hsVolRate` | Taux HS composante vol (par heure) | — | `tauxMoyen × 0,25` |
| Taux moyen | `tauxMoyen` | Rémunération vol / HC brut | — | `pvEur / totalHc` *(fallback: PVEI×KSP si HC=0)* |
| HS € | `fin.hs` | Montant heures supplémentaires | — | `hsH × (hsFixeRate + hsVolRate)` |
| P (primes) | `fin.primes` | Total primes du mois | Bi-tronçon + fixes | `Σ(prime_bitroncon) + monthlyFixedPrimes` *(voir §2c)* |
| **Total** | `fin.total` | Paie brute hors congés | — | `FIXE + PV€ + HS€ + DIF + P` |
| Congés | `congeAmount` | Indemnité jours de congé | — | `congeDays × (cngPv + cngHs)` |
| BRUT | `brut` | Total avec congés, indemnités | — | `fin.total + congeAmount` |

### 2c. Primes mensuelles fixes

| Prime | Mon terme | Définition | Formule implémentée |
|-------|-----------|------------|---------------------|
| Prime bi-tronçon | `finBase.primes` | Par service ≥ 2 tronçons hors TLV/BEY | `count × 2,5 × PVEI` *(sans KSP)* |
| Prime incitation | `primeIncitationUnit × incitCount` | 0–5 primes selon saisie | `primeIncitationUnit × incitCount` *(non boostée en juillet/août)* |
| Prime A330 | `primeA330` | Prime avion A330 | `primeA330 × nb30e/30` |
| Prime instruction | `primeInstruction` | Prime TRI/ICPL | `primeInstruction × nb30e/30` |
| — | `a330InstrBoost` | Boost juillet/août TAF*_10_12 | `fullPrime ? 30/nb30eRégime : 1` | *inutile je suppose avec la modification* 
| Prime mai | — | *(non implémentée)* | 0 |
| Prime noël | — | *(non implémentée)* | 0 |

---

## 3. Formules EP4 (Feuilles d'activité)

### 3a. Par tronçon (leg)

| Terme EP4 | Mon terme | Définition | Formule EP4 | Formule implémentée |
|-----------|-----------|------------|-------------|---------------------|
| TDV/tronçon | `leg.tdv_troncon` | Durée block du leg | ARR − DEP | `(leg.arr_ms − leg.dep_ms) / 3 600 000` |
| HV100r | `leg.hv100r` | TDV majoré 0,58 | — | `tdv_troncon + 0,58` |
| HCVmoisM | `leg.hcv_mois_m` | Proration HCV sur le mois M | — | `HCV × (ms dans M / durée totale leg)` *(cf fonction `prorateHcvMoisM`)* |
| MEP | `leg.dead_head` | Mise en place (pilote passager) | — | depuis `dutyLegAssociation.deadHead` | *MEP pour mise en place*

### 3b. Par service (flightDuty)

| Terme EP4 | Mon terme | Définition | Formule EP4 | Formule implémentée |
|-----------|-----------|------------|-------------|---------------------|
| BLOCK/BLOCK | `svc.block_block` | Durée porte à porte du service | — | `(dernier ARR − premier DEP) / 3 600 000` |
| TSV | `svc.tsv` | Temps de service en vol | `schFlDutyTime` | lu depuis `flightDutyValue[0].schFlDutyTime` |
| TME | `svc.TME` | Temps moyen par tronçon | — | `max(1, Σ(tdv_troncon) / nb_tronçons)` |
| CMT | `svc.CMT` | Coefficient multiplicateur tronçons | `70/(21×TME+30)` si TME≤2, sinon 1 | idem |
| HCV | `svc.HCV` | Heures créditées vol | `Σ(tdv_troncon) × CMT × (0,5 si DH)` | idem |
| HCT | `svc.HCT` | Heures créditées TSV | `TSV / 1,75` | idem |
| H1 | `svc.H1` | Max(HCV, HCT) | — | `max(HCV, HCT)` |
| HCVr | `svc.HCVr` | HCV avec hv100r | `Σ(hv100r) × CMT × (0,5 si DH)` | idem |
| H1r | `svc.H1r` | Max(HCVr, HCT) | — | `max(HCVr, HCT)` |
| TSVnuit J | `svc.tsv_nuit_j` | TSV nuit sur jour J | — | `tsvNuitJ(heure_dep_locale, block_block)` *(cf `lib/ep4/night.ts`)* |
| TSVnuit J+1 | `svc.tsv_nuit_j1` | TSV nuit sur jour J+1 | — | `tsvNuitJ1(heure_dep_locale, block_block)` |
| TSVnuit | `svc.tsv_nuit` | Total nuit service | — | `tsv_nuit_j + tsv_nuit_j1` |
| TSVnSerM | `svc.tsv_n_ser_m` | Nuit proratisé sur mois M | — | selon quel mois le départ/arrivée tombe *(cf `computeTsvNSerM`)* |

### 3c. Par rotation

| Terme EP4 | Mon terme | Définition | Formule EP4 | Formule implémentée |
|-----------|-----------|------------|-------------|---------------------|
| HDV | `ep4.HDV` | Heures de vol totales | — | `pairingValue[0].flightTime` |
| HC | `ep4.HC` | Heures créditées totales | — | `pairingValue[0].creditedHour` |
| ON | `ep4.ON` | Jours on (présence) | — | `pairingValue[0].nbOnDays` |
| TDV total | `ep4.TDV_total` | Durée service totale | — | `pairingValue[0].workedFlightTime` |
| TA | `ep4.TA` | Temps d'absence (durée totale rotation) | — | `(fin_vol_ms − debut_vol_ms) / 3 600 000` |
| HCA | `ep4.HCA` | Heures créditées absence | `TA × 5/24` | idem |
| rtHDV | `ep4.rtHDV` | Ratio proratisation mensuelle | `Σ(HCVmoisM) / Σ(HCV)` | idem |
| H2HC (initial) | `ep4.H2HC_initial` | Max(HCA, ΣH1) avant ratio | — | `max(HCA, ΣH1)` |
| H2HC | `ep4.H2HC` | HC final proratisé | — | `rtHDV × max(HCA, ΣH1)` |
| H2HCr (initial) | `ep4.H2HCr_initial` | — | — | `max(HCA, ΣH1r)` |
| H2HCr | `ep4.H2HCr` | HC final proratisé (hv100r) | — | `rtHDV × max(HCA, ΣH1r)` |
| ONm | `ep4.ONm` | ON proratisé sur mois M | — | `computeOnM(...)` *(jours entiers dans M)* |
| Prime bi-tronçon | `ep4.Prime` | Nombre de primes bi-tronçon | 1 par service ≥ 2 legs hors TLV/BEY | idem |
| TSVnRotM | `ep4.tsv_n_rot_m` | Somme TSVnSerM | — | `Σ(svc.tsv_n_ser_m)` |
| Temps séjour | `ep4.tempsSej` | Durée séjour (entre services) | DEP dernier svc − ARR premier svc | `(dep_last_svc_first_leg − arr_first_svc_last_leg) / 3 600 000` |
| TauxApp | `ep4.tauxApp` | Taux d'application A81 | lookup table `taux_app` | `lookupTauxApp(taux, rotation_code, tempsSej)` |

---

## 4. IR / MF (Indemnité Repas / Menus Frais)

| Terme EP4 | Mon terme | Définition | Formule implémentée |
|-----------|-----------|------------|---------------------|
| IR | `ep4.IR` | Nombre d'indemnités repas | Créneaux couverts ≥ 1h (midi 11–15h, soir 18–22h, heure locale) — dédup par (jour, slot) | cf `lib/ep4/ir.ts` |
| MF | `ep4.MF` | Nombre de menus frais | Subset IR dont escale ≥ 3h | idem |
| IR € | `ep4.IR_eur` | Montant IR | `Σ(IR × taux_escale)` | lookup `annexe_table` slug `ir_mf_rates` |
| MF € | `ep4.MF_eur` | Montant MF | `20 % × IR€ par escale` | idem |
| "En vol" | — | Couverture IR en vol | `[dep − 1h15, arr + 15min]` | idem |
| "En escale" | — | Couverture IR en escale | `[end_ms service i, begin_ms service i+1]` | idem |

---

## 5. Article 81

| Terme EP4 | Mon terme | Définition | Formule implémentée |
|-----------|-----------|------------|---------------------|
| Temps séjour | `tSej` | Durée séjour en heures | *(même que `ep4.tempsSej`)* | — |
| tSej24 | `tSej24` | Tranche de jours (pas 0,5j) | `ceil((tSej + 0,25h) / 24 × 2) / 2` si ≥ 24h, sinon 0 | `computeTSej24(tSej)` |
| Taux séjour | `tauxSej` | Taux lookup zone × durée | lookup matrice annexe (`article_81`) | `lookupTauxSej(data, zone, tSej)` |
| Prime séjour | `montantPrimeSej` | Montant pour la rotation | `valeurJour × tauxSej × tSej24` | idem |
| Prime séjour/j | `montantPrimeSejJour` | Montant unitaire (1 jour) | `valeurJour × tauxSej` | idem |
| Plafond annuel | `plafondJours` | Max jours défiscalisés/an | TP : 70j ; TAF7_10/12 : 56,5j ; TAF7_12/12 : 53,5j ; TAF10 : 56,5j / 53,5j | `getPlafondJours(regime)` |
| Cumul jours | `cumulJoursRunning` | Cumul jours depuis janv. | Σ(tSej24) des rotations dans l'ordre chrono, arrêt au plafond | *(cross-mois via `a81CumulBefore`)* |

> Le montant Article 81 est proratisé sur le mois M pour les vols à cheval (`prorateForMonth`).  
> Le calcul utilise le `tSej` de la signature (déjà calculé par le scraper).

---

## 6. Prorata / Badge ON

| Mon terme | Définition | Source | Formule |
|-----------|------------|--------|---------|
| `joursProrata` | Jours non travaillés à déduire | — | `congeDays + tafDays` |
| `tafDays` | Jours TAF du mois | selon `tafOk` | `tafOk ? getTafDuration(regime) : 0` |
| `tafOk` | TAF disponible ce mois | régime + mois | `isTafAvailable(regime, currentMonth)` *(false en juillet/août pour TAF\*_10_12)* |
| `jiRestants` | Jours JI (journées intra) restants | table `prorata` slug | `lookupJI(joursProrata, prorataThresholds)` |
| `yMax` | Limite max de jours ON affichable | — | `dim − jiRestants − joursProrata` |
| `dim` | Nombre de jours dans le mois | — | `daysInMonth(year, mo)` |

---

## 7. Formules "colonne paie" manquantes / en attente

| Terme | Statut | Note |
|-------|--------|------|
| Prime Mai | ❌ non implémentée | Lot "AUTRE MODIFICATION" |
| Prime Noël | ❌ non implémentée | Lot "AUTRE MODIFICATION" |
| Recalcul IR/MF mensuel via EP4 | ⚠ lu en DB (`ir_mf_rates`) | Implémenté mais formule non vérifiée vs EP4 Python |
| IT (Indemnité de vol de nuit) | ❌ non implémentée | Backlog AUTRE MODIFICATION |
| MGA sans fullPrime (régime normal) | ⚠ à confirmer | Formule courante : `FIXE_MENSUEL + 85×(nb30e/30)×PVEI` *oui, il suffit davoir un nb30e fonction du mois et du profil*

---

## 8. ANNEXE :

### Taux avion (ou "Taux horaire de base des primes de vol")
AVION | Primes de vol
A350 | 101.36
A335 | 103.39
B787 | 99.95
B777 | 104.49

### Bonus ATPL = 0.06

### Coef. Classe 
FONCTION | Classe | Coef. Classe
CDB | Classe 1 | 1.55
CDB | Classe 2 | 1.45
CDB | Classe 3 | 1.35
CDB | Classe 4 | 1.3
CDB | Classe 5 | 1.25
OPL | Classe 1 | 1.08
OPL | Classe 2 | 1.03
OPL | Classe 3 | 0.98
OPL | Classe 4 | 0.93
OPL | Classe 5 | 0.88

### Catégorie d'ancienneté
Catégorie d'ancienneté | Coefficient
Catégorie A | 0.7
Catégorie B | 0.85
Catégorie C | 1

### Nombre de 30e par régime
| Régime | `nb30e` (JAN-JUN + SEP-DEC) | `nb30e` (JUL-AUG) |
| TP | 30 | 30 |
| TAF7_10_12 | 23 | 30 |
| TAF7_12_12 | 23 | 23 |
| TAF10_10_12 | 20 | 30 |
| TAF10_12_12 | 20 | 20 |
*dépend donc du mois*

### Echelon (ou Echelon d'ancinneté)
Catégorie d'ancinneté | Echelon | Coefficient
Catégorie A | Echelon 1 | 1
Catégorie B | Echelon 2 | 1.15
Catégorie C | Echelon 3 | 1.3
Catégorie C | Echelon 4 | 1.4
Catégorie C | Echelon 5 | 1.5
Catégorie C | Echelon 6 | 1.6
Catégorie C | Echelon 7 | 1.7
Catégorie C | Echelon 8 | 1.8
Catégorie C | Echelon 9 | 1.9
Catégorie C | Echelon 10 | 2

### CoefficientFonction
Fonction | Coef. Fonction
OPL | 0.665
CDB | 1

### Traitement mensuel fixe
Traitement mensuel fixe = 2559.19