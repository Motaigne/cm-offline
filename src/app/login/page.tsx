export default function LoginPage() {
  return (
    <main className="flex-1 flex flex-col items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Connexion</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Accès sur invitation uniquement.
          </p>
        </div>
        <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
          Flow d&apos;auth à implémenter.
          <br />
          (magic link Supabase ou email/password)
        </div>
      </div>
    </main>
  );
}
