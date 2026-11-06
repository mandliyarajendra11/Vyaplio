# Paid pilot admin setup

The admin screen and paid provisioning require a hosted Supabase project. This repository has no live Supabase credentials; local builds show the screens but cannot issue accounts until you configure the project.

1. Run `supabase/schema.sql`, then `supabase/admin.sql` in the Supabase SQL Editor. After any later rerun of `schema.sql`, rerun `admin.sql` so the paid access policies remain in place.
2. Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and server-only `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` and the deployment environment. Never expose the service key in `NEXT_PUBLIC_` variables, Git, screenshots, or WhatsApp.
3. Create the first admin with `npm run admin:bootstrap -- you@example.com`. The command refuses to run until the project is configured, then prints a random temporary password once. It refuses to create a second admin.
4. Open `/login` and sign in with that email and temporary password. The app recognizes the server-side admin role and takes you to the required password-change screen before opening `/admin`. There is no public admin registration or hard-coded admin password.
5. Confirm a buyer's payment in your bank or Razorpay dashboard, enter the buyer/shop/plan and a unique payment reference, and create the account. The temporary password appears once. Give the buyer the email, temporary password, and `/activate` link privately.
6. The buyer opens `/activate` on **their own phone**, chooses a new password, and the cloud shop downloads to that phone. Add real products there. The first-week checklist is available from the app.

The admin form records manual payment confirmation. It does not collect money, verify a UPI screenshot, renew a plan, or send WhatsApp messages. Yearly expiry is stored as one calendar year from provisioning; renewing/adjusting a plan needs a later admin action. A shop already open offline can still use its local data until it reconnects; the cloud policy blocks expired access on the server.

Applying `admin.sql` marks existing cloud shops as `legacy` with zero recorded revenue so their existing data remains accessible. Review those accounts manually before the paid pilot.

`admin.sql` also creates an account audit trail. New paid accounts and first activation are recorded automatically. Future renewal and disable updates must set `last_action_by` to the verified admin user ID and `last_action_id` to a fresh UUID; the database rejects an account change without these values. The history starts when this migration is applied and cannot reconstruct earlier actions. The admin screen shows the latest 100 actions; the database retains older entries.

If you already created an admin user manually in Supabase Authentication, add its user ID in the SQL Editor instead of running the bootstrap script: `insert into admin_users (user_id) values ('YOUR_AUTH_USER_UUID');` That account uses its existing password.
