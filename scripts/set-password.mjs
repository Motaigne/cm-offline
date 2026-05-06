// Usage: node scripts/set-password.mjs <email> <password>
import { createClient } from '@supabase/supabase-js';

const [,, email, password] = process.argv;
if (!email || !password) {
  console.error('Usage: node scripts/set-password.mjs <email> <password>');
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers();
if (listErr) { console.error(listErr.message); process.exit(1); }

const user = users.find(u => u.email === email);
if (!user) { console.error(`Utilisateur "${email}" introuvable`); process.exit(1); }

const { error } = await supabase.auth.admin.updateUserById(user.id, { password });
if (error) { console.error(error.message); process.exit(1); }

console.log(`✓ Mot de passe défini pour ${email}`);
