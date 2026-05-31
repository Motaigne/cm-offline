'use client';

import { useState, useTransition, useEffect } from 'react';
import { addAllowedEmail, removeAllowedEmail, setUserScraperRole, backfillTsvNuit } from '@/app/actions/admin';
import type { Database } from '@/types/supabase';

type AllowedEmail = Pick<Database['public']['Tables']['allowed_email']['Row'], 'email' | 'added_at' | 'note'>;
type AuthLog      = Pick<Database['public']['Tables']['auth_log']['Row'], 'id' | 'email' | 'kind' | 'created_at' | 'meta'>;
type UserProfile  = { user_id: string; display_name: string | null; is_admin: boolean; is_scraper: boolean };

// Bascule pour réafficher les outils de maintenance (Recalculer tsv_nuit,
// Backfill RPC repos avant/après). Réactivé pour patcher RPC LAX-PPT-LAX et
// autres erreurs ponctuelles en attendant le fix B (RPC par-instance).
const SHOW_MAINT_TOOLS = true;

const KIND_LABELS: Record<AuthLog['kind'], { label: string; cls: string }> = {
  signin_denied:      { label: 'Refusé',     cls: 'text-red-500' },
  signin_requested:   { label: 'Demande',    cls: 'text-zinc-500' },
  signin_success:     { label: 'Connecté',   cls: 'text-emerald-500' },
  signout:            { label: 'Déconnecté', cls: 'text-zinc-400' },
  db_download:        { label: 'Download',   cls: 'text-blue-500' },
  release_published:  { label: 'Publication', cls: 'text-violet-500' },
  release_downloaded: { label: 'Release ↓',  cls: 'text-cyan-500' },
};

export function WhitelistClient({ emails, logs, profiles }: { emails: AllowedEmail[]; logs: AuthLog[]; profiles: UserProfile[] }) {
  const [newEmail, setNewEmail] = useState('');
  const [newNote,  setNewNote]  = useState('');
  const [err,      setErr]      = useState('');
  const [isPending, start]      = useTransition();
  const [profileList, setProfileList] = useState(profiles);

  const [backfillStatus, setBackfillStatus] = useState<string>('');

  // Import CSV historique (Jan→Mai 2026)
  const [csvBusy,   setCsvBusy]   = useState(false);
  const [csvStatus, setCsvStatus] = useState<string[]>([]);

  // Wipe mois (Jan→Mai 2026 par défaut)
  const [wipeBusy,   setWipeBusy]   = useState(false);
  const [wipeStatus, setWipeStatus] = useState('');

  // Backfill RPC (rest_before_h / rest_after_h)
  const [showRpcForm, setShowRpcForm]   = useState(false);
  const [rpcMonth,  setRpcMonth]        = useState('');
  const [rpcCookie, setRpcCookie]       = useState('');
  const [rpcSn,     setRpcSn]           = useState('');
  const [rpcUserId, setRpcUserId]       = useState('');
  const [rpcStatus, setRpcStatus]       = useState('');
  const [rpcBusy,   setRpcBusy]         = useState(false);

  useEffect(() => {
    setRpcSn(localStorage.getItem('af_sn') ?? '');
    setRpcUserId(localStorage.getItem('af_userid') ?? '');
    // Mois courant par défaut
    const now = new Date();
    setRpcMonth(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  }, []);

  async function handleBackfillRpc() {
    if (!rpcCookie || !rpcSn || !rpcUserId) return;
    localStorage.setItem('af_sn', rpcSn);
    localStorage.setItem('af_userid', rpcUserId);
    setRpcBusy(true);
    setRpcStatus('1 requête pairingsearch en cours…');
    try {
      const res = await fetch('/api/admin/backfill-rest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month: rpcMonth, cookie: rpcCookie, sn: rpcSn, userId: rpcUserId }),
      });
      if (!res.ok) { setRpcStatus(`! ${await res.text()}`); return; }
      const j = await res.json() as { updated: number; unchanged: number; missing: number; total: number };
      setRpcStatus(`✓ ${j.updated} mises à jour · ${j.unchanged} inchangées · ${j.missing} absentes search · ${j.total} totales`);
      // Ne pas fermer le formulaire automatiquement : le rpcStatus est rendu
      // à l'intérieur, donc le fermer fait disparaître le récap aussitôt.
      // L'admin ferme manuellement après avoir lu le résultat.
    } catch (e) {
      setRpcStatus(`! ${String(e)}`);
    } finally {
      setRpcBusy(false);
    }
  }

  async function handleWipeMonths() {
    const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'];
    if (!window.confirm(`Vider les snapshots + sigs + instances pour ${months.join(', ')} ?\n\nLes planning_item utilisateurs seront préservés (pairing_instance_id remis à null).`)) return;
    setWipeBusy(true);
    setWipeStatus('en cours…');
    try {
      const res = await fetch('/api/admin/wipe-months', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ months }),
      });
      if (!res.ok) {
        setWipeStatus(`! ${await res.text()}`);
        return;
      }
      const j = await res.json() as { results: Array<{ month: string; snapshots: number; signatures: number; instances: number; items_unlinked: number }> };
      const totalSigs = j.results.reduce((a, r) => a + r.signatures, 0);
      const totalInst = j.results.reduce((a, r) => a + r.instances, 0);
      const totalUnlinked = j.results.reduce((a, r) => a + r.items_unlinked, 0);
      setWipeStatus(`✓ ${totalSigs} sigs · ${totalInst} inst supprimées · ${totalUnlinked} items unlinkés`);
    } catch (e) {
      setWipeStatus(`! ${String(e)}`);
    } finally {
      setWipeBusy(false);
    }
  }

  async function handleImportCsv(files: FileList | null) {
    if (!files || files.length === 0) return;
    setCsvBusy(true);
    setCsvStatus([]);
    const logs: string[] = [];
    // Apparie les fichiers par mois. Noms attendus :
    //   - 8_cleanEp4_MMYYYY.csv  (rotations uniques, source des sigs)
    //   - 1_extract_MMYYYY.csv   (toutes les actID datées, source des instances)
    type Pair = { month: string; clean?: File; extract?: File };
    const byMonth = new Map<string, Pair>();
    for (const file of Array.from(files)) {
      const m = file.name.match(/(\d{2})(\d{4})\.csv$/i);
      if (!m) {
        logs.push(`! ${file.name} : nom non reconnu (attendu *MMYYYY.csv)`);
        continue;
      }
      const month = `${m[2]}-${m[1]}`;
      const pair = byMonth.get(month) ?? { month };
      if (/^8_cleanEp4/i.test(file.name)) pair.clean = file;
      else if (/^1_extract/i.test(file.name)) pair.extract = file;
      else {
        logs.push(`! ${file.name} : préfixe inconnu (attendu 8_cleanEp4_* ou 1_extract_*)`);
        continue;
      }
      byMonth.set(month, pair);
    }
    setCsvStatus([...logs]);

    // Boucle par mois (ordre chronologique pour lisibilité)
    const months = Array.from(byMonth.keys()).sort();
    for (const month of months) {
      const pair = byMonth.get(month)!;
      if (!pair.clean) {
        logs.push(`! ${month} : 8_cleanEp4 manquant (extract seul ne suffit pas)`);
        setCsvStatus([...logs]);
        continue;
      }
      const tag = pair.extract ? 'clean+extract' : 'clean seul (instances dégradées)';
      logs.push(`… ${month} (${tag})`);
      setCsvStatus([...logs]);
      try {
        const csvText = await pair.clean.text();
        const extractCsvText = pair.extract ? await pair.extract.text() : undefined;
        const res = await fetch('/api/admin/import-csv-month', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ month, csvText, extractCsvText }),
        });
        if (!res.ok) {
          logs[logs.length - 1] = `! ${month} : ${await res.text()}`;
        } else {
          const j = await res.json() as {
            cleanEp4: { inserted: number; skipped: number; errors: number; in_target_month: number };
            extract:  { inserted: number; skipped: number; unmatched: number; in_target_month: number };
            errorSamples: string[];
          };
          logs[logs.length - 1] =
            `✓ ${month} sigs +${j.cleanEp4.inserted}/${j.cleanEp4.in_target_month} (${j.cleanEp4.skipped} dups) · inst +${j.extract.inserted}/${j.extract.in_target_month} (${j.extract.skipped} dups, ${j.extract.unmatched} non matchés)`;
          if (j.errorSamples?.length) {
            for (const s of j.errorSamples) logs.push(`   · ${s}`);
          }
        }
      } catch (e) {
        logs[logs.length - 1] = `! ${month} : ${String(e)}`;
      }
      setCsvStatus([...logs]);
    }
    setCsvBusy(false);
  }

  function handleBackfillTsvNuit() {
    if (!window.confirm('Recalculer tsv_nuit pour toutes les signatures avec raw_detail ?\n\nFormule alignée sur EP4 (per-service avec padding 1.5h). Pas de re-scrape AF, juste DB read+write.')) return;
    setBackfillStatus('en cours…');
    start(async () => {
      try {
        const res = await backfillTsvNuit();
        setBackfillStatus(`✓ ${res.updated} mises à jour · ${res.unchanged} inchangées · ${res.errors} erreurs · ${res.total} totales`);
      } catch (e) {
        setBackfillStatus(`! ${String(e)}`);
      }
    });
  }

  function handleToggleScraper(userId: string, current: boolean) {
    const next = !current;
    // Optimistic
    setProfileList(prev => prev.map(p => p.user_id === userId ? { ...p, is_scraper: next } : p));
    start(async () => {
      const res = await setUserScraperRole(userId, next);
      if (res?.error) {
        setErr(res.error);
        // Revert
        setProfileList(prev => prev.map(p => p.user_id === userId ? { ...p, is_scraper: current } : p));
      }
    });
  }

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    start(async () => {
      const res = await addAllowedEmail(newEmail, newNote);
      if (res?.error) setErr(res.error);
      else { setNewEmail(''); setNewNote(''); }
    });
  }

  function handleRemove(email: string) {
    if (!window.confirm(`Retirer ${email} de la whitelist ?`)) return;
    start(async () => {
      const res = await removeAllowedEmail(email);
      if (res?.error) setErr(res.error);
    });
  }

  return (
    <div className="space-y-6">

      {/* Outils admin */}
      {SHOW_MAINT_TOOLS && (
      <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4">
        <h2 className="text-sm font-semibold mb-1">Outils</h2>
        <p className="text-[11px] text-zinc-400 mb-3">Maintenance DB.</p>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={handleBackfillTsvNuit}
            disabled={isPending}
            className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold disabled:opacity-40 transition-colors"
          >
            Recalculer tsv_nuit (formule EP4)
          </button>
          {backfillStatus && (
            <span className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">{backfillStatus}</span>
          )}

          {/* Backfill RPC */}
          <button
            onClick={() => { setShowRpcForm(s => !s); setRpcStatus(''); }}
            className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition-colors"
          >
            Backfill RPC (repos avant/après)
          </button>

          {/* Wipe mois Jan→Mai 2026 */}
          <button
            onClick={handleWipeMonths}
            disabled={wipeBusy}
            className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold disabled:opacity-40 transition-colors"
          >
            {wipeBusy ? '…' : 'Wipe Jan→Mai 2026'}
          </button>
          {wipeStatus && (
            <span className={`text-[11px] font-mono ${wipeStatus.startsWith('✓') ? 'text-emerald-600 dark:text-emerald-400' : wipeStatus.startsWith('!') ? 'text-red-500' : 'text-zinc-500'}`}>
              {wipeStatus}
            </span>
          )}

          {/* Import CSV historique (Jan→Mai 2026) */}
          <label className={`px-3 py-1.5 rounded-lg text-white text-xs font-semibold transition-colors cursor-pointer ${csvBusy ? 'bg-zinc-400 cursor-not-allowed' : 'bg-emerald-600 hover:bg-emerald-500'}`}>
            {csvBusy ? '…' : 'Import CSV historique (8_cleanEp4 + 1_extract)'}
            <input
              type="file"
              accept=".csv,text/csv"
              multiple
              disabled={csvBusy}
              className="hidden"
              onChange={e => { void handleImportCsv(e.target.files); e.target.value = ''; }}
            />
          </label>
        </div>

        {csvStatus.length > 0 && (
          <div className="mt-2 p-2 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 font-mono text-[11px] space-y-0.5">
            {csvStatus.map((s, i) => (
              <div key={i} className={
                s.startsWith('✓') ? 'text-emerald-600 dark:text-emerald-400'
                  : s.startsWith('!') ? 'text-red-500'
                  : 'text-zinc-500 dark:text-zinc-400'
              }>{s}</div>
            ))}
          </div>
        )}

        {showRpcForm && (
          <div className="mt-3 p-3 rounded-lg border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/30 space-y-2">
            <p className="text-[11px] text-sky-700 dark:text-sky-300">
              1 requête pairingsearch → mise à jour rest_before_h / rest_after_h sur le dernier snapshot success du mois.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-zinc-500 mb-0.5">Mois (YYYY-MM)</label>
                <input value={rpcMonth} onChange={e => setRpcMonth(e.target.value)}
                  className="w-full text-xs rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1" />
              </div>
              <div>
                <label className="block text-[10px] text-zinc-500 mb-0.5">SN</label>
                <input value={rpcSn} onChange={e => setRpcSn(e.target.value)}
                  className="w-full text-xs rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1" />
              </div>
              <div>
                <label className="block text-[10px] text-zinc-500 mb-0.5">User ID</label>
                <input value={rpcUserId} onChange={e => setRpcUserId(e.target.value)}
                  className="w-full text-xs rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1" />
              </div>
              <div>
                <label className="block text-[10px] text-zinc-500 mb-0.5">Cookie AF</label>
                <input value={rpcCookie} onChange={e => setRpcCookie(e.target.value)} type="password"
                  placeholder="JSESSIONID=…"
                  className="w-full text-xs rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1" />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleBackfillRpc}
                disabled={rpcBusy || !rpcCookie || !rpcSn || !rpcUserId}
                className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold disabled:opacity-40 transition-colors"
              >
                {rpcBusy ? '…' : 'Lancer'}
              </button>
              {rpcStatus && (
                <span className={`text-[11px] font-mono ${rpcStatus.startsWith('✓') ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
                  {rpcStatus}
                </span>
              )}
            </div>
          </div>
        )}
      </section>
      )}

      {/* Scrapers : toggle per profile */}
      <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800">
        <header className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">Scrapers ({profileList.filter(p => p.is_scraper || p.is_admin).length} actifs)</h2>
          <p className="text-[11px] text-zinc-400 mt-0.5">
            Les admins peuvent toujours scraper. Les scrapers non-admin sont limités à 50 rotations par run.
          </p>
        </header>
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800 max-h-[40vh] overflow-y-auto">
          {profileList.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-zinc-400">Aucun profil enregistré.</li>
          )}
          {profileList.map(p => (
            <li key={p.user_id} className="flex items-center justify-between px-4 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
              <div className="min-w-0 flex items-center gap-2 flex-wrap">
                <span className="font-medium text-zinc-800 dark:text-zinc-100 truncate">
                  {p.display_name || <span className="text-zinc-400 italic">sans nom</span>}
                </span>
                {p.is_admin && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 font-semibold">
                    ADMIN
                  </span>
                )}
              </div>
              {p.is_admin ? (
                <span className="text-[11px] text-zinc-400">scraper auto (admin)</span>
              ) : (
                <button
                  onClick={() => handleToggleScraper(p.user_id, p.is_scraper)}
                  disabled={isPending}
                  className={[
                    'px-3 py-1 rounded-full text-xs font-semibold transition-colors disabled:opacity-40',
                    p.is_scraper
                      ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                      : 'bg-zinc-200 hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-zinc-600 dark:text-zinc-300',
                  ].join(' ')}
                >
                  {p.is_scraper ? '✓ Scraper' : 'Inactif'}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Liste des emails autorisés */}
      <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800">
        <header className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">Emails autorisés ({emails.length})</h2>
        </header>

        <form onSubmit={handleAdd} className="p-4 space-y-2 border-b border-zinc-100 dark:border-zinc-800">
          <div className="flex gap-2">
            <input
              type="email"
              value={newEmail}
              onChange={e => setNewEmail(e.target.value)}
              placeholder="email@exemple.com"
              required
              className="flex-1 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm"
            />
            <input
              type="text"
              value={newNote}
              onChange={e => setNewNote(e.target.value)}
              placeholder="note (facultative)"
              className="flex-1 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm"
            />
            <button
              type="submit"
              disabled={isPending}
              className="rounded bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-3 py-1 text-sm font-medium disabled:opacity-40"
            >
              Ajouter
            </button>
          </div>
          {err && <p className="text-xs text-red-500">{err}</p>}
        </form>

        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800 max-h-[60vh] overflow-y-auto">
          {emails.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-zinc-400">
              Aucun email autorisé pour l&apos;instant.
            </li>
          )}
          {emails.map(e => (
            <li key={e.email} className="flex items-center justify-between px-4 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
              <div className="min-w-0">
                <p className="font-mono text-zinc-800 dark:text-zinc-100 truncate">{e.email}</p>
                {e.note && <p className="text-[11px] text-zinc-400 truncate">{e.note}</p>}
                <p className="text-[10px] text-zinc-400">
                  {new Date(e.added_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}
                </p>
              </div>
              <button
                onClick={() => handleRemove(e.email)}
                disabled={isPending}
                className="text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 px-2 py-1 rounded disabled:opacity-40"
              >
                Retirer
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* Journal d'authentification */}
      <section className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800">
        <header className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">Journal d&apos;authentification (100 derniers)</h2>
        </header>
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800 max-h-[68vh] overflow-y-auto">
          {logs.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-zinc-400">
              Pas encore d&apos;événement.
            </li>
          )}
          {logs.map(l => {
            const k = KIND_LABELS[l.kind];
            return (
              <li key={l.id} className="px-4 py-2 text-xs flex items-center gap-3">
                <span className={`font-semibold w-20 flex-shrink-0 ${k.cls}`}>{k.label}</span>
                <span className="font-mono text-zinc-700 dark:text-zinc-200 truncate flex-1">{l.email}</span>
                <span className="text-[10px] text-zinc-400 flex-shrink-0">
                  {new Date(l.created_at).toLocaleString('fr-FR', {
                    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
      </div>
    </div>
  );
}
