import { LoginForm } from './login-form';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="flex-1 flex flex-col items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Connexion</h1>
          <p className="mt-1 text-sm text-zinc-500">Accès sur invitation uniquement.</p>
        </div>
        <LoginForm urlError={error} />
      </div>
    </main>
  );
}
