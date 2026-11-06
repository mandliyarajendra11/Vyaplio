/* eslint-disable @typescript-eslint/no-require-imports */
// One-time bootstrap after the Supabase project and admin.sql have been configured.
const { randomBytes } = require('node:crypto');
const { loadEnvConfig } = require('@next/env');
const { createClient } = require('@supabase/supabase-js');

loadEnvConfig(process.cwd());
const email = (process.argv[2] || '').trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  process.stderr.write('Usage: npm run admin:bootstrap -- you@example.com\n');
  process.exitCode = 1;
} else if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  process.stderr.write('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local first.\n');
  process.exitCode = 1;
} else {
  (async () => {
    const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: admins, error: lookupError } = await service.from('admin_users').select('user_id').limit(1);
    if (lookupError) throw new Error('Run supabase/admin.sql before bootstrapping the admin.');
    if (admins.length) throw new Error('An admin already exists. This command only creates the first admin.');
    const temporaryPassword = randomBytes(18).toString('base64url');
    const { data, error: createError } = await service.auth.admin.createUser({ email, password: temporaryPassword, email_confirm: true });
    if (createError || !data.user) throw new Error(createError?.message || 'Could not create admin user.');
    const { error: roleError } = await service.from('admin_users').insert({ user_id: data.user.id, must_change_password: true });
    if (roleError) {
      await service.auth.admin.deleteUser(data.user.id);
      throw new Error('Could not assign admin role; created user was removed.');
    }
    process.stdout.write(`Admin email: ${email}\nTemporary password: ${temporaryPassword}\nOpen /login, sign in, then choose a new admin password. This password is shown once.\n`);
  })().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
