import { SetupPasswordForm } from './setup-form';

export default async function SetupPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <main className="flex-1 flex flex-col items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Créer un mot de passe</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Ce mot de passe te permettra de te connecter directement depuis la PWA.
          </p>
        </div>
        <SetupPasswordForm next={next ?? '/'} />
      </div>
    </main>
  );
}
