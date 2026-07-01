import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { EmptyCacheBanner } from '@/app/components/empty-cache-banner';
import { ErudaDebug } from '@/app/components/eruda-debug';
import { MountBeacon } from '@/app/components/mount-beacon';

// Watchdog de boot (filet de secours). Script INLINE dans l'HTML statique (donc
// exécuté même si aucun chunk JS ne charge). Si React n'a pas monté après 10s
// (window.__cmMounted posé par <MountBeacon/>), affiche un overlay
// « Réparer et recharger » qui vide les caches HTML/RSC (others+rsc) puis
// recharge — sortie de secours pour l'écran blanc (chunk manquant / cache
// incohérent wifi captif). Ne touche NI les chunks immuables NI Dexie.
const BOOT_WATCHDOG = `
(function(){
  var T=10000;
  function repair(btn){
    if(btn){btn.disabled=true;btn.textContent='Nettoyage…';}
    var done=function(){location.reload();};
    var tasks=[];
    try{ if(window.caches){ tasks.push(caches.delete('others')); tasks.push(caches.delete('rsc')); } }catch(e){}
    Promise.all(tasks).then(done).catch(done);
    setTimeout(done,3000);
  }
  function show(){
    if(window.__cmMounted) return;
    if(document.getElementById('cm-recovery')) return;
    var d=document.createElement('div');
    d.id='cm-recovery';
    d.setAttribute('style','position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:28px;background:#0A0A0A;color:#fafafa;font-family:system-ui,-apple-system,sans-serif;text-align:center');
    var p=document.createElement('div');
    p.setAttribute('style','font-size:15px;line-height:1.5;max-width:320px');
    p.innerHTML='L\\'app n\\'a pas pu démarrer.<br>Cache incohérent (wifi avion / réseau captif).';
    var b=document.createElement('button');
    b.textContent='Réparer et recharger';
    b.setAttribute('style','padding:12px 22px;border-radius:10px;border:0;background:#2563eb;color:#fff;font-size:15px;font-weight:600');
    b.onclick=function(){repair(b);};
    d.appendChild(p);d.appendChild(b);
    document.body.appendChild(d);
  }
  window.addEventListener('cm-mounted',function(){var e=document.getElementById('cm-recovery');if(e)e.remove();});
  setTimeout(show,T);
})();
`;

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

const APP_NAME = 'CM-offline';
const APP_DESCRIPTION = 'Planning & simulation paie';

export const metadata: Metadata = {
  applicationName: APP_NAME,
  title: { default: APP_NAME, template: '%s · CM-offline' },
  description: APP_DESCRIPTION,
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: APP_NAME,
    startupImage: ['/icons/icon-512.png'],
  },
  icons: {
    icon: '/icons/icon-192.png',
    apple: '/icons/icon-192.png',
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: '#0A0A0A',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="fr"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        {/* Watchdog de boot inline (cf. BOOT_WATCHDOG) + beacon de montage. */}
        <script dangerouslySetInnerHTML={{ __html: BOOT_WATCHDOG }} />
        <MountBeacon />
        {/* Banner global : s'affiche uniquement si Dexie est vide (drafts +
            rotations + releases = 0). Permet à un user offline / sur un cache
            fraichement vidé de restaurer une sauvegarde depuis n'importe
            quelle page, sans devoir d'abord atterrir sur /offline. */}
        <EmptyCacheBanner />
        {/* Debug overlay activable via ?eruda=1 (persisté localStorage).
            Permet d'inspecter console/network/IndexedDB sur iPad sans Mac. */}
        <ErudaDebug />
        {children}
      </body>
    </html>
  );
}
