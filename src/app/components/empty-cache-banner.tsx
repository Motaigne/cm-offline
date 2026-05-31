'use client';

import { useEffect, useRef, useState } from 'react';
import {
  parseBackupFile, importPlanning, importDatabase, importLegacyBackup,
} from '@/lib/backup';
import { db } from '@/lib/local-db';

/**
 * Bandeau d'alerte si le cache Dexie est vide (drafts + rotations + releases).
 * Cas typique : l'utilisateur a vidé le cache navigateur hors ligne, ou ouvre
 * l'app pour la première fois sans réseau. Propose de Sync (si en ligne) ou
 * de restaurer un fichier de sauvegarde.
 */
export function EmptyCacheBanner() {
  const [empty, setEmpty]   = useState<boolean | null>(null); // null = unknown
  const [status, setStatus] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Recheck après import (sans recharger la page, juste mettre à jour le bandeau).
  const recheck = async (): Promise<void> => {
    try {
      const [d, r, rel] = await Promise.all([
        db.drafts.count(), db.rotations.count(), db.releases.count(),
      ]);
      setEmpty(d === 0 && r === 0 && rel === 0);
    } catch { setEmpty(false); }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [d, r, rel] = await Promise.all([
          db.drafts.count(), db.rotations.count(), db.releases.count(),
        ]);
        if (!cancelled) setEmpty(d === 0 && r === 0 && rel === 0);
      } catch { if (!cancelled) setEmpty(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  async function onFile(file: File) {
    try {
      const text = await file.text();
      const backup = parseBackupFile(text);
      if (!('kind' in backup)) {
        await importLegacyBackup(backup);
        setStatus('✓ planning legacy restauré');
      } else if (backup.kind === 'planning') {
        await importPlanning(backup);
        setStatus(`✓ planning restauré (${backup.items.length} items)`);
      } else if (backup.kind === 'database') {
        await importDatabase(backup);
        setStatus(`✓ DB restaurée (${backup.rotations.length} rotations)`);
      }
      await recheck();
      // Recharge la page pour que les server components prennent en compte
      // (sur /offline, ça permet de retourner au calendrier alimenté).
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      setStatus(`! ${String(e)}`);
      setTimeout(() => setStatus(''), 4000);
    }
  }

  if (empty !== true) return null;

  return (
    <div className="bg-amber-50 dark:bg-amber-950/40 border-b border-amber-300 dark:border-amber-700 px-4 py-2.5 flex items-center gap-3 text-sm">
      <span className="text-base flex-shrink-0">⚠</span>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-amber-900 dark:text-amber-200">Cache local vide</p>
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          Aucune donnée hors ligne. Lance la Sync (si réseau) ou restaure un fichier de sauvegarde.
        </p>
      </div>
      <button
        onClick={() => fileInputRef.current?.click()}
        className="flex-shrink-0 px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium"
      >
        Restaurer…
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
          e.target.value = '';
        }}
      />
      {status && (
        <span className={`text-[10px] font-mono ${status.startsWith('✓') ? 'text-emerald-600' : 'text-red-600'}`}>
          {status}
        </span>
      )}
    </div>
  );
}
