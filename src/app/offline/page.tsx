import Link from 'next/link';
import { NavBar } from '@/app/components/nav';

export const metadata = { title: 'Hors ligne' };

export default function OfflinePage() {
  return (
    <>
      <NavBar />
      <main className="flex-1 flex flex-col items-center justify-center p-8 text-center gap-3">
        <span className="text-4xl">📵</span>
        <h1 className="text-2xl font-semibold">Hors ligne</h1>
        <p className="max-w-sm text-sm text-zinc-500">
          Pas de réseau. Les données déjà téléchargées restent accessibles
          depuis le calendrier.
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
