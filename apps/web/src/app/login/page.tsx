export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  invalid: "Nieprawidłowe hasło.",
  locked: "Zbyt wiele nieudanych prób. Spróbuj ponownie za 15 minut.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="min-h-screen grid place-items-center px-4">
      <form method="post" action="/api/auth/login" className="w-full max-w-sm card p-8 space-y-5">
        <div>
          <h1 className="text-xl font-semibold">Trading 2.2</h1>
          <p className="text-sm text-muted mt-1">Panel agentów. Dostęp chroniony hasłem.</p>
        </div>
        <label className="block space-y-1.5">
          <span className="text-sm text-muted">Hasło</span>
          <input name="password" type="password" autoComplete="current-password" required autoFocus className="input w-full" />
        </label>
        {error && MESSAGES[error] && <p className="text-sm text-bad">{MESSAGES[error]}</p>}
        <button className="btn btn-primary w-full" type="submit">Zaloguj</button>
      </form>
    </main>
  );
}
