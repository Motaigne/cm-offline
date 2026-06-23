-- ============================================================
-- 0042_rotation_zones
-- Insère dans `annexe_table` (slug='rotation_zones') le mapping
-- `rotation_code → zone Article 81` extrait de
-- `sources/AF_Paie_Rot81 - zone.csv`.
--
-- Pourquoi : pour les mois avec EP4 importé, on extrait les rotations
-- directement du PDF (cf src/lib/a81-ep4-match.ts). Le PDF ne contient
-- PAS la zone Article 81, indispensable au calcul du taux. Avant, on
-- la déduisait du cache des signatures (`zoneByEscale`) — robuste si
-- l'user a déjà vu une rotation similaire, mais pas universel.
--
-- Cette table devient la source canonique : `rotation_code` formaté
-- comme la colonne ROT du CSV (escales visitées hors-base, séparées par
-- un espace, ex "BZV PNR", "LAX PPT LAX"). Lookup côté A81 :
--   1. match exact sur rotation_code (joint(escales, ' '))
--   2. fallback escale_debut seule (1ère escale)
--   3. fallback signature cachée (sigByEscale)
--
-- L'user peut éditer cette table via /annexe pour compléter les
-- rotations manquantes. Source CSV : 67 lignes, à jour 2026-06-23.
-- ============================================================

insert into annexe_table (slug, name, description, data) values (
  'rotation_zones',
  'Zones Article 81 par code rotation',
  'Map rotation_code (escales visitées hors-base séparées par un espace) → zone (AFR/AME/APC/CSA/MGI/PAC/COI). Utilisé pour calculer le taux séjour quand la zone n''est pas connue depuis le scrape AF (rotation extraite d''un EP4 PDF). Source : AF_Paie_Rot81 - zone.csv.',
  '{
    "version": "2026-06-23",
    "rotations": [
      { "rot": "ABJ",           "zone": "AFR" },
      { "rot": "ABV LFW",       "zone": "AFR" },
      { "rot": "ATL",           "zone": "AME" },
      { "rot": "BEY",           "zone": "MGI" },
      { "rot": "BKK",           "zone": "APC" },
      { "rot": "BLR",           "zone": "MGI" },
      { "rot": "BOG",           "zone": "CSA" },
      { "rot": "BOS",           "zone": "AME" },
      { "rot": "BZV",           "zone": "AFR" },
      { "rot": "BZV FIH",       "zone": "AFR" },
      { "rot": "BZV PNR",       "zone": "AFR" },
      { "rot": "CAI",           "zone": "AFR" },
      { "rot": "CKY",           "zone": "AFR" },
      { "rot": "CKY NKC",       "zone": "AFR" },
      { "rot": "CPT",           "zone": "AFR" },
      { "rot": "CPT JNB",       "zone": "AFR" },
      { "rot": "DFW",           "zone": "AME" },
      { "rot": "DLA",           "zone": "AFR" },
      { "rot": "DTW",           "zone": "AME" },
      { "rot": "EWR",           "zone": "AME" },
      { "rot": "EZE",           "zone": "CSA" },
      { "rot": "FIH BZV FIH",   "zone": "AFR" },
      { "rot": "FIH BZV PNR",   "zone": "AFR" },
      { "rot": "FOR",           "zone": "CSA" },
      { "rot": "GIG",           "zone": "CSA" },
      { "rot": "GRU",           "zone": "CSA" },
      { "rot": "HKG",           "zone": "APC" },
      { "rot": "HND",           "zone": "APC" },
      { "rot": "IAD",           "zone": "AME" },
      { "rot": "IAH",           "zone": "AME" },
      { "rot": "ICN",           "zone": "APC" },
      { "rot": "JFK",           "zone": "AME" },
      { "rot": "JIB",           "zone": "AFR" },
      { "rot": "JNB",           "zone": "AFR" },
      { "rot": "JRO ZNZ",       "zone": "AFR" },
      { "rot": "LAS",           "zone": "AME" },
      { "rot": "LAX PPT LAX",   "zone": "PAC" },
      { "rot": "PPT",           "zone": "PAC" },
      { "rot": "LFW",           "zone": "AFR" },
      { "rot": "MCO",           "zone": "AME" },
      { "rot": "MEX",           "zone": "AME" },
      { "rot": "MIA",           "zone": "AME" },
      { "rot": "MNL",           "zone": "PAC" },
      { "rot": "MNL HKG",       "zone": "PAC" },
      { "rot": "NBJ",           "zone": "AFR" },
      { "rot": "NBO",           "zone": "AFR" },
      { "rot": "NBO JRO ZNZ",   "zone": "AFR" },
      { "rot": "NDJ NSI",       "zone": "AFR" },
      { "rot": "NKC",           "zone": "AFR" },
      { "rot": "NKC CKY",       "zone": "AFR" },
      { "rot": "NSI",           "zone": "AFR" },
      { "rot": "ORD",           "zone": "AME" },
      { "rot": "PHX",           "zone": "AME" },
      { "rot": "PTY",           "zone": "CSA" },
      { "rot": "RDU",           "zone": "AME" },
      { "rot": "RUH",           "zone": "MGI" },
      { "rot": "SCL",           "zone": "CSA" },
      { "rot": "SEA",           "zone": "AME" },
      { "rot": "SFO",           "zone": "AME" },
      { "rot": "SGN",           "zone": "APC" },
      { "rot": "SJO",           "zone": "CSA" },
      { "rot": "SSA",           "zone": "CSA" },
      { "rot": "SSG DLA",       "zone": "AFR" },
      { "rot": "SXM",           "zone": "COI" },
      { "rot": "TNR",           "zone": "AFR" },
      { "rot": "YUL",           "zone": "AME" },
      { "rot": "YVR",           "zone": "AME" },
      { "rot": "YYZ",           "zone": "AME" }
    ]
  }'::jsonb
)
on conflict do nothing;
