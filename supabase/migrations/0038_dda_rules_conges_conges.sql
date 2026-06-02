-- ============================================================
-- 0038_dda_rules_conges_conges
-- Ajoute la règle d'enchaînement CONGES ↔ CONGES dans annexe_table dda_rules.
-- "CONGES" couvre côté validator les kinds : conge, conge_ss (CSS), taf (TA).
-- Spec optiP_DEF : CONGES/TA/CSS ↔ CONGES/TA/CSS = 0-1 OK / 2-6 X / 7+ OK.
--
-- On insère une nouvelle version (valid_from = '2026-06-02') plutôt que de
-- mutate la jsonb de la row 0025 — le pattern annexe_table est versionné par
-- valid_from (cf. mig 0028), et les anciens mois doivent continuer à utiliser
-- l'ancienne matrice.
-- ============================================================

insert into annexe_table (slug, valid_from, name, description, data) values (
  'dda_rules',
  '2026-06-01',
  'Règles DDA — v2026-06 (ajout CONGES↔CONGES)',
  'Ajoute la règle d''enchaînement CONGES↔CONGES (0-1 OK, 2-6 X, 7+ OK). CONGES couvre conge + conge_ss + taf côté validator.',
  '{
    "version": "2026-06-01",
    "rules": [
      { "from": "DDA_REPOS", "to": "DDA_REPOS", "gap_from": "end", "gap_to": "start", "ok": [0, 1], "forbidden": [2], "min_ok_above": 3 },
      { "from": "DDA_REPOS", "to": "CONGES",    "gap_from": "end", "gap_to": "start", "ok": [0, 1], "forbidden": [2, 3, 4], "min_ok_above": 5 },
      { "from": "DDA_REPOS", "to": "DDA_VOL",   "gap_from": "end", "gap_to": "start", "ok": [0, 1], "forbidden": [2, 3, 4], "min_ok_above": 5 },
      { "from": "CONGES",    "to": "DDA_REPOS", "gap_from": "end", "gap_to": "start", "ok": [0, 1], "forbidden": [2], "min_ok_above": 3 },
      { "from": "CONGES",    "to": "DDA_VOL",   "gap_from": "end", "gap_to": "start", "ok": [0, 1], "forbidden": [2, 3, 4], "min_ok_above": 5 },
      { "from": "CONGES",    "to": "CONGES",    "gap_from": "end", "gap_to": "start", "ok": [0, 1], "forbidden": [2, 3, 4, 5, 6], "min_ok_above": 7 },
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
