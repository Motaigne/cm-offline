'use client';

import { useEffect, useState } from 'react';

function urlBase64ToUint8Array(b64: string): Uint8Array {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

export type PushStatus =
  | 'unsupported'        // navigator/Push API absent
  | 'ios-not-installed'  // iOS Safari mais PWA non installée
  | 'denied'
  | 'default'            // permission default — bouton à afficher pour demander
  | 'subscribed';

/** Détection synchrone du statut initial — `null` si une lookup async via le
 *  service worker est nécessaire (cas typique). SSR → 'unsupported' (pas de
 *  navigator), cohérent avec le client lors de l'hydration. */
function detectInitialStatus(): PushStatus | null {
  if (typeof window === 'undefined') return 'unsupported';
  const ok = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!ok) return 'unsupported';
  if (isIOS() && !isStandalone()) return 'ios-not-installed';
  return null;
}

export function usePushSubscription(): { status: PushStatus; subscribe: () => Promise<void> } {
  // Init lazy : si on peut décider en synchrone, on évite le 1er render dans un
  // état faux. Sinon on rend 'unsupported' provisoire puis le useEffect cale.
  const [status, setStatus] = useState<PushStatus>(() => detectInitialStatus() ?? 'unsupported');

  useEffect(() => {
    // Statut déjà fixé en synchrone via l'initializer → rien à faire.
    if (detectInitialStatus() !== null) return;

    void (async () => {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) { setStatus('subscribed'); return; }

      if (Notification.permission === 'denied') { setStatus('denied'); return; }
      if (Notification.permission === 'granted') {
        // Permission déjà accordée mais pas encore subscribed — on subscribe direct.
        try { await doSubscribe(reg); setStatus('subscribed'); }
        catch { setStatus('default'); }
        return;
      }
      setStatus('default');
    })();
  }, []);

  async function subscribe(): Promise<void> {
    const reg = await navigator.serviceWorker.ready;
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { setStatus(perm === 'denied' ? 'denied' : 'default'); return; }
    try { await doSubscribe(reg); setStatus('subscribed'); }
    catch (err) { console.error('[push] subscribe failed:', err); setStatus('default'); }
  }

  return { status, subscribe };
}

async function doSubscribe(reg: ServiceWorkerRegistration): Promise<void> {
  const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapidKey) throw new Error('NEXT_PUBLIC_VAPID_PUBLIC_KEY manquant');

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
  });

  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(json),
  });
  if (!res.ok) {
    await sub.unsubscribe().catch(() => undefined);
    throw new Error(`Subscribe failed: HTTP ${res.status}`);
  }
}
