'use client';

import { useState, useEffect, useRef } from 'react';
import type { ScrapeEvent } from '@/lib/scraper/types';

type Partial = { processed: number; total: number };

type Phase =
  | { name: 'idle' }
  | { name: 'analyzing' }
  | { name: 'ready'; total_instances: number; unique_sigs: number; partial: Partial | null }
  | { name: 'scraping'; current: number; total: number; rotation: string }
  | { name: 'done'; snapshot_id: string; signatures: number; instances: number }
  | { name: 'stopped'; current: number; total: number; resumable: boolean }
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

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setSn(localStorage.getItem('af_sn') ?? '');
    setUserId(localStorage.getItem('af_userid') ?? '');
  }, []);

  const canEdit = phase.name === 'idle' || phase.name === 'ready' || phase.name === 'stopped' || phase.name === 'error' || phase.name === 'done';
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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month, cookie, sn, userId }),
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => String(res.status));
        setPhase({ name: 'error', message: msg });
        return;
      }
      const data = await res.json();
      setPhase({
        name: 'ready',
        total_instances: data.total_instances,
        unique_sigs: data.unique_sigs,
        partial: data.partial ?? null,
      });
    } catch (err) {
      setPhase({ name: 'error', message: String(err) });
    }
  }

  async function startScrape(resume = false) {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase({ name: 'scraping', current: 0, total: 0, rotation: 'Démarrage…' });

    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month, cookie, sn, userId, resume }),
        signal: ctrl.signal,
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
              setPhase({ name: 'scraping', current: event.current, total: event.total, rotation: event.rotation });
            } else if (event.type === 'done') {
              setPhase({ name: 'done', snapshot_id: event.snapshot_id, signatures: event.signatures, instances: event.instances });
              onDone();
            } else if (event.type === 'error') {
              setPhase({ name: 'error', message: event.message });
            }
          } catch { /* ignore malformed line */ }
        }
      }

      // Stream ended without a done/error event (e.g. server closed mid-way)
      setPhase(prev => prev.name === 'scraping'
        ? { name: 'stopped', current: lastProgress.current, total: lastProgress.total, resumable: lastProgress.current > 0 }
        : prev);

    } catch (err: any) {
      if (err?.name === 'AbortError') {
        setPhase(prev => prev.name === 'scraping'
          ? { name: 'stopped', current: prev.current, total: prev.total, resumable: prev.current > 0 }
          : { name: 'stopped', current: 0, total: 0, resumable: false });
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
            <div className="bg-zinc-50 dark:bg-zinc-800 rounded-xl p-3 text-sm">
              <p className="text-zinc-700 dark:text-zinc-200 font-medium">
                {phase.unique_sigs} rotations uniques · {phase.total_instances} dates
              </p>
              {phase.partial ? (
                <p className="text-amber-600 dark:text-amber-400 text-xs mt-1">
                  ⏸ Téléchargement précédent interrompu : {phase.partial.processed}/{phase.partial.total} déjà reçues. Reprendre pour continuer là où vous vous étiez arrêté.
                </p>
              ) : (
                <p className="text-zinc-400 text-xs mt-0.5">Confirmer pour lancer le scraping complet</p>
              )}
            </div>
          )}

          {phase.name === 'scraping' && (
            <div className="bg-zinc-50 dark:bg-zinc-800 rounded-xl p-3 space-y-2 text-xs">
              <p className="text-zinc-600 dark:text-zinc-300 truncate">
                {phase.current < phase.total
                  ? <><span className="font-mono">{phase.rotation}</span></>
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
                ✓ {phase.signatures} rotations · {phase.instances} dates importées
              </p>
            </div>
          )}

          {phase.name === 'stopped' && (
            <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 text-sm">
              <p className="text-amber-700 dark:text-amber-400">
                Arrêté à {phase.current}/{phase.total}
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
                  {phase.partial ? (
                    <button
                      onClick={() => startScrape(true)}
                      className="flex-1 py-3 rounded-xl bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700 active:bg-amber-800 transition-colors"
                    >
                      Reprendre
                    </button>
                  ) : (
                    <button
                      onClick={() => startScrape(false)}
                      className="flex-1 py-3 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 active:bg-blue-800 transition-colors"
                    >
                      Confirmer
                    </button>
                  )}
                </>
              )}
              {(phase.name === 'stopped' || phase.name === 'error') && (
                <>
                  {phase.name === 'stopped' && phase.resumable && (
                    <button
                      onClick={() => startScrape(true)}
                      className="flex-1 py-3 rounded-xl bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700 active:bg-amber-800 transition-colors"
                    >
                      Reprendre
                    </button>
                  )}
                  <button
                    onClick={reset}
                    className="flex-1 py-3 rounded-xl border border-zinc-300 dark:border-zinc-700 text-sm font-semibold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                  >
                    Recommencer
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
