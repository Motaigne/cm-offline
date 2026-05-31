import Link from 'next/link';
import { NavBar } from '@/app/components/nav';
import { EmptyCacheBanner } from '@/app/components/empty-cache-banner';

export const metadata = { title: 'Hors ligne' };

export default function OfflinePage() {
  return (
    <>
      <NavBar />
      <EmptyCacheBanner />
      <main className="flex-1 flex flex-col items-center justify-center p-8 text-center gap-3">
        <span className="text-4xl">📵</span>
        <h1 className="text-2xl font-semibold">Hors ligne</h1>
        <p className="max-w-sm text-sm text-zinc-500">
          Pas de réseau. Les données déjà téléchargées restent accessibles
          depuis le calendrier.
        </p>
        <p className="max-w-sm text-xs text-zinc-400">
          Si l&apos;app n&apos;a aucune donnée locale (cache vidé), restaure une
          sauvegarde via le bouton 💾 dans la barre du haut.
        </p>
        <Link
          href="/"
          className="mt-2 px-4 py-2 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm font-medium"
        >
          ← Retour au calendrier
        </Link>
      </main>
    </>
  );
}
