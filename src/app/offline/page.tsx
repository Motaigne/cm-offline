export const metadata = { title: 'Hors ligne' };

export default function OfflinePage() {
  return (
    <main className="flex-1 flex flex-col items-center justify-center p-8 text-center">
      <h1 className="text-2xl font-semibold">Hors ligne</h1>
      <p className="mt-2 max-w-sm text-sm text-zinc-500">
        Pas de réseau. Les données déjà téléchargées restent accessibles
        depuis le calendrier.
      </p>
    </main>
  );
}
