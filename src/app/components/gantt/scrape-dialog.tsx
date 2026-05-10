'use client';

import { useState, useEffect, useRef } from 'react';
import type { ScrapeEvent } from '@/lib/scraper/types';
import { getCurrentUserScrapeRights } from '@/app/actions/auth';

const NON_ADMIN_CAP = 50;

type Phase =
  | { name: 'idle' }
  | { name: 'analyzing' }
  | { name: 'ready'; total_instances: number; unique_sigs: number; in_db: number; missing: number }
  | { name: 'scraping'; current: number; total: number; rotation: string }
  | { name: 'done'; snapshot_id: string; signatures: number; instances: number }
  | { name: 'stopped'; current: number; total: number }
  | { name: 'error'; message: string };

export function ScrapeDialog({
  currentMonth,
  onClose,
  onDone,
}: {
  currentMonth: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [month,  setMonth]  = useState(currentMonth);
  const [cookie, setCookie] = useState('');
  const [sn,     setSn]     = useState('');
  const [userId, setUserId] = useState('');
  const [phase,  setPhase]  = useState<Phase>({ name: 'idle' });
  const [maxRotations, setMaxRotations] = useState<string>(''); // vide = tout (cappé serveur)
  const [isAdmin, setIsAdmin] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setSn(localStorage.getItem('af_sn') ?? '');
    setUserId(localStorage.getItem('af_userid') ?? '');
    void getCurrentUserScrapeRights().then(r => setIsAdmin(r.is_admin)).catch(() => {});
  }, []);

  const effectiveCap = isAdmin ? Infinity : NON_ADMIN_CAP;

  const canEdit =
    phase.name === 'idle' ||
    phase.name === 'ready' ||
    phase.name === 'stopped' ||
    phase.name === 'error' ||
    phase.name === 'done';

  const canAnalyze = !!cookie && !!sn && !!userId && canEdit;

  function reset() {
    abortRef.current?.abort();
    setPhase({ name: 'idle' });
  }

  async function analyze() {
    if (!canAnalyze) return;
    localStorage.setItem('af_sn', sn);
    localStorage.setItem('af_userid', userId);
    setPhase({ name: 'analyzing' });

    try {
      const res = await fetch('/api/scrape/preview', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ month, cookie, sn, userId }),
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => String(res.status));
        setPhase({ name: 'error', message: msg });
        return;
      }
      const data = await res.json();
      setPhase({
        name:            'ready',
        total_instances: data.total_instances,
        unique_sigs:     data.unique_sigs,
        in_db:           data.in_db,
        missing:         data.missing,
      });
    } catch (err) {
      setPhase({ name: 'error', message: String(err) });
    }
  }

  async function startScrape() {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase({ name: 'scraping', current: 0, total: 0, rotation: 'Démarrage…' });

    const parsedMax = parseInt(maxRotations, 10);
    const maxParam = !isNaN(parsedMax) && parsedMax > 0
      ? Math.min(parsedMax, effectiveCap === Infinity ? parsedMax : effectiveCap)
      : undefined;

    try {
      const res = await fetch('/api/scrape', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ month, cookie, sn, userId, maxRotations: maxParam }),
        signal:  ctrl.signal,
      });

      if (!res.ok || !res.body) {
        const msg = await res.text().catch(() => String(res.status));
        setPhase({ name: 'error', message: msg });
        return;
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let lastProgress = { current: 0, total: 0 };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event: ScrapeEvent = JSON.parse(line.slice(6));
            if (event.type === 'progress') {
              lastProgress = { current: event.current, total: event.total };
              setPhase({
                name:     'scraping',
                current:  event.current,
                total:    event.total,
                rotation: event.rotation,
              });
            } else if (event.type === 'done') {
              setPhase({
                name:        'done',
                snapshot_id: event.snapshot_id,
                signatures:  event.signatures,
                instances:   event.instances,
              });
              onDone();
            } else if (event.type === 'error') {
              setPhase({ name: 'error', message: event.message });
            }
          } catch { /* ignore malformed line */ }
        }
      }

      // Stream coupé sans event final.
      setPhase(prev => prev.name === 'scraping'
        ? { name: 'stopped', current: lastProgress.current, total: lastProgress.total }
        : prev);

    } catch (err: any) {
      if (err?.name === 'AbortError') {
        setPhase(prev => prev.name === 'scraping'
          ? { name: 'stopped', current: prev.current, total: prev.total }
          : { name: 'stopped', current: 0, total: 0 });
      } else {
        setPhase({ name: 'error', message: String(err) });
      }
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  const isBlocking = phase.name === 'analyzing' || phase.name === 'scraping';
  const pct = phase.name === 'scraping' && phase.total > 0
    ? Math.round((phase.current / phase.total) * 100)
    : 0;

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/40"
        onClick={isBlocking ? undefined : onClose}
      />
      <div className="fixed inset-x-4 top-1/2 -translate-y-1/2 z-50 max-w-md mx-auto bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl p-5 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm">Importer un mois</h2>
          {!isBlocking && (
            <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 text-2xl leading-none w-8 h-8 flex items-center justify-center">×</button>
          )}
        </div>

        {/* Fields */}
        <div className="space-y-3">
          <Row label="Mois">
            <input
              type="month"
              value={month}
              onChange={e => setMonth(e.target.value)}
              disabled={!canEdit}
              className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-sm"
            />
          </Row>
          <Row label="Cookie AF">
            <textarea
              value={cookie}
              onChange={e => setCookie(e.target.value)}
              disabled={!canEdit}
              placeholder="JSESSIONID=…"
              rows={2}
              className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-xs font-mono resize-none"
            />
          </Row>
          <Row label="Token SN">
            <input
              value={sn}
              onChange={e => setSn(e.target.value)}
              disabled={!canEdit}
              placeholder="eu7Z8S6B…"
              className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-sm font-mono"
            />
          </Row>
          <Row label="User ID AF">
            <input
              value={userId}
              onChange={e => setUserId(e.target.value)}
              disabled={!canEdit}
              placeholder="00123456"
              className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-sm font-mono"
            />
          </Row>
        </div>

        {/* Status area */}
        <div className="space-y-3">

          {phase.name === 'analyzing' && (
            <div className="flex items-center gap-2 text-sm text-zinc-500">
              <span className="animate-spin">⏳</span> Analyse en cours…
            </div>
          )}

          {phase.name === 'ready' && (
            <div className="bg-zinc-50 dark:bg-zinc-800 rounded-xl p-3 text-sm space-y-2">
              <p className="text-zinc-700 dark:text-zinc-200 font-medium">
                {phase.unique_sigs} rotations uniques · {phase.total_instances} dates
              </p>
              {phase.missing > 0 ? (
                <p className="text-amber-600 dark:text-amber-400 text-xs">
                  {phase.in_db} déjà en DB · <strong>{phase.missing}</strong> à télécharger
                </p>
              ) : (
                <p className="text-emerald-600 dark:text-emerald-400 text-xs">
                  ✓ Tout est déjà en DB ({phase.in_db}/{phase.unique_sigs})
                </p>
              )}
              {phase.missing > 0 && (
                <div className="flex items-center gap-2 text-xs pt-1 border-t border-zinc-200 dark:border-zinc-700">
                  <label className="text-zinc-500">Max rotations à scraper :</label>
                  <input
                    type="number" min={1}
                    max={isAdmin ? phase.missing : Math.min(phase.missing, NON_ADMIN_CAP)}
                    value={maxRotations}
                    onChange={e => setMaxRotations(e.target.value)}
                    placeholder={String(isAdmin ? phase.missing : Math.min(phase.missing, NON_ADMIN_CAP))}
                    className="w-16 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-center font-mono"
                  />
                  <span className="text-zinc-400">
                    / {phase.missing}{!isAdmin && phase.missing > NON_ADMIN_CAP && (
                      <span className="text-amber-600 ml-1">(plafond {NON_ADMIN_CAP} non-admin)</span>
                    )}
                  </span>
                </div>
              )}
            </div>
          )}

          {phase.name === 'scraping' && (
            <div className="bg-zinc-50 dark:bg-zinc-800 rounded-xl p-3 space-y-2 text-xs">
              <p className="text-zinc-600 dark:text-zinc-300 truncate">
                {phase.current < phase.total
                  ? <span className="font-mono">{phase.rotation}</span>
                  : '✓ Tous les détails récupérés'
                }
                <span className="text-zinc-400 ml-1">({phase.current}/{phase.total})</span>
              </p>
              <div className="w-full h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-700">
                <div
                  className="h-1.5 rounded-full bg-blue-500 transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )}

          {phase.name === 'done' && (
            <div className="bg-green-50 dark:bg-green-900/20 rounded-xl p-3 text-sm">
              <p className="text-green-700 dark:text-green-400 font-medium">
                ✓ DB du mois : {phase.signatures} rotations · {phase.instances} dates
              </p>
            </div>
          )}

          {phase.name === 'stopped' && (
            <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 text-sm">
              <p className="text-amber-700 dark:text-amber-400">
                Arrêté à {phase.current}/{phase.total}. Relancer l'analyse pour reprendre.
              </p>
            </div>
          )}

          {phase.name === 'error' && (
            <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-3 text-sm">
              <p className="text-red-600 dark:text-red-400">❌ {phase.message}</p>
            </div>
          )}

          {/* Action buttons */}
          {(phase.name === 'idle' || phase.name === 'ready' || phase.name === 'stopped' || phase.name === 'error') && (
            <div className="flex gap-2">
              {phase.name === 'idle' && (
                <button
                  onClick={analyze}
                  disabled={!canAnalyze}
                  className="flex-1 py-3 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 active:bg-blue-800 disabled:opacity-40 transition-colors"
                >
                  Analyser
                </button>
              )}

              {phase.name === 'ready' && (
                <>
                  <button
                    onClick={reset}
                    className="flex-1 py-3 rounded-xl border border-zinc-300 dark:border-zinc-700 text-sm font-semibold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                  >
                    Annuler
                  </button>
                  {phase.missing > 0 ? (() => {
                    const parsed = parseInt(maxRotations, 10);
                    const cap = isAdmin ? phase.missing : Math.min(phase.missing, NON_ADMIN_CAP);
                    const willDownload = !isNaN(parsed) && parsed > 0 ? Math.min(parsed, cap) : cap;
                    return (
                      <button
                        onClick={startScrape}
                        className="flex-1 py-3 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 active:bg-blue-800 transition-colors"
                      >
                        Télécharger {willDownload}
                      </button>
                    );
                  })() : (
                    <button
                      onClick={onClose}
                      className="flex-1 py-3 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 transition-colors"
                    >
                      Fermer
                    </button>
                  )}
                </>
              )}

              {(phase.name === 'stopped' || phase.name === 'error') && (
                <>
                  <button
                    onClick={analyze}
                    disabled={!canAnalyze}
                    className="flex-1 py-3 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 active:bg-blue-800 disabled:opacity-40 transition-colors"
                  >
                    Réanalyser
                  </button>
                  <button
                    onClick={onClose}
                    className="flex-1 py-3 rounded-xl bg-zinc-700 text-white text-sm font-semibold hover:bg-zinc-600 transition-colors"
                  >
                    Fermer
                  </button>
                </>
              )}
            </div>
          )}

          {phase.name === 'scraping' && (
            <button
              onClick={stop}
              className="w-full py-3 rounded-xl border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 text-sm font-semibold hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            >
              Stop
            </button>
          )}

          {phase.name === 'done' && (
            <button
              onClick={onClose}
              className="w-full py-3 rounded-xl bg-zinc-700 text-white text-sm font-semibold hover:bg-zinc-600 transition-colors"
            >
              Fermer
            </button>
          )}

        </div>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-xs text-zinc-500 w-20 pt-2.5 flex-shrink-0">{label}</span>
      {children}
    </div>
  );
}
