-- ============================================================
-- 0025_annexe_dda_rules
-- 1. Étend l'enum bid_category avec 'elabo_suivi' pour la nouvelle
--    catégorie (exempte de validation DDA).
-- 2. Insère 2 entrées dans annexe_table avec les règles d'enchaînement :
--    - dda_rules   : DDA REPOS / DDA VOL / CONGES (CSV optiP_dataBase_dda.csv)
--    - vol_p_rules : enchaînements impliquant un VOL P (CSV optiP_dataBase_volP.csv)
-- Référentiel: sources/dda_rules.json
--
-- Conventions du JSON :
--   - "from" / "to" : catégorie en majuscules (DDA_REPOS, DDA_VOL, VOL_P, CONGES)
--   - "gap_from" : "end" | "rpc_first_day" | "rpc_last_day"
--   - "gap_to"   : "start" | "block_off"
--   - "ok", "forbidden" : tableaux d'entiers (jours)
--   - "min_ok_above" : à partir de N jours et au-delà → OK
--   - "rpc_dependent" + "rpc": { "1": {...}, "2": {...}, "3": {...} }
--   - "rpc_report_alt" : règle alternative si l'utilisateur accepte le report
--     du RPC à la fin des CONGES (DDA VOL → CONGES uniquement).
-- ============================================================

alter type bid_category add value if not exists 'elabo_suivi';

insert into annexe_table (slug, name, description, data) values (
  'dda_rules',
  'Règles DDA — enchaînement entre DDA REPOS / DDA VOL / CONGES',
  'Pour chaque paire d''activités, indique le nombre de jours d''écart (gap) admis (OK) ou interdit (X). Source : optiP_dataBase_dda.csv.',
  '{
    "version": "2026-05-22",
    "rules": [
      { "from": "DDA_REPOS", "to": "DDA_REPOS", "gap_from": "end", "gap_to": "start", "ok": [0, 1], "forbidden": [2], "min_ok_above": 3 },
      { "from": "DDA_REPOS", "to": "CONGES",    "gap_from": "end", "gap_to": "start", "ok": [0, 1], "forbidden": [2, 3, 4], "min_ok_above": 5 },
      { "from": "DDA_REPOS", "to": "DDA_VOL",   "gap_from": "end", "gap_to": "start", "ok": [0, 1], "forbidden": [2, 3, 4], "min_ok_above": 5 },
      { "from": "CONGES",    "to": "DDA_REPOS", "gap_from": "end", "gap_to": "start", "ok": [0, 1], "forbidden": [2], "min_ok_above": 3 },
      { "from": "CONGES",    "to": "DDA_VOL",   "gap_from": "end", "gap_to": "start", "ok": [0, 1], "forbidden": [2, 3, 4], "min_ok_above": 5 },
      { "from": "DDA_VOL", "to": "DDA_REPOS", "gap_from": "rpc_first_day", "gap_to": "start", "rpc_dependent": true,
        "rpc": {
          "1": { "ok": [0, 1], "forbidden": [2, 3], "min_ok_above": 4 },
          "2": { "ok": [0, 1], "forbidden": [2, 3], "min_ok_above": 4 },
          "3": { "ok": [0, 1], "forbidden": [2, 3, 4], "min_ok_above": 5 }
        }
      },
      { "from": "DDA_VOL", "to": "CONGES", "gap_from": "rpc_last_day", "gap_to": "start",
        "ok": [0, 1], "forbidden": [2, 3, 4], "min_ok_above": 5,
        "rpc_report_alt": {
          "note": "Si l''utilisateur accepte le report du RPC à la fin des CONGES, la règle devient 0-1 OK depuis la fin du vol (RPC ignoré).",
          "gap_from": "end_no_rpc", "gap_to": "start", "ok": [0, 1]
        }
      },
      { "from": "DDA_VOL", "to": "DDA_VOL", "gap_from": "rpc_last_day", "gap_to": "block_off",
        "ok": [0, 1], "forbidden": [2, 3, 4], "min_ok_above": 5
      }
    ]
  }'::jsonb
);

insert into annexe_table (slug, name, description, data) values (
  'vol_p_rules',
  'Règles VOL P — enchaînement impliquant un VOL P',
  'VOL P est moins tolérant qu''un DDA VOL : un jour de RPC en moins absorbable. Source : optiP_dataBase_volP.csv.',
  '{
    "version": "2026-05-22",
    "rules": [
      { "from": "DDA_REPOS", "to": "VOL_P", "gap_from": "end", "gap_to": "start", "ok": [0], "forbidden": [1, 2, 3, 4], "min_ok_above": 5 },
      { "from": "CONGES",    "to": "VOL_P", "gap_from": "end", "gap_to": "start", "ok": [0], "forbidden": [1, 2, 3, 4], "min_ok_above": 5 },
      { "from": "DDA_VOL",   "to": "VOL_P", "gap_from": "rpc_last_day", "gap_to": "start", "ok": [0], "forbidden": [1, 2, 3, 4], "min_ok_above": 5 },
      { "from": "VOL_P", "to": "DDA_REPOS", "gap_from": "end", "gap_to": "start", "rpc_dependent": true,
        "rpc": {
          "1": { "ok": [0], "forbidden": [1, 2, 3], "min_ok_above": 4 },
          "2": { "ok": [0], "forbidden": [1, 2, 3, 4], "min_ok_above": 5 },
          "3": { "ok": [0], "forbidden": [1, 2, 3, 4, 5], "min_ok_above": 6 }
        }
      },
      { "from": "VOL_P", "to": "CONGES", "gap_from": "rpc_last_day", "gap_to": "start",
        "ok": [0], "forbidden": [1, 2, 3, 4], "min_ok_above": 5
      },
      { "from": "VOL_P", "to": "DDA_VOL", "gap_from": "rpc_last_day", "gap_to": "block_off",
        "ok": [0], "forbidden": [1, 2, 3, 4], "min_ok_above": 5
      }
    ]
  }'::jsonb
);
