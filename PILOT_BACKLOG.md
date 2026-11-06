# Vyaplio pilot backlog

Status: planned. Work through these items one by one before the paid pilot. Keep the shop app usable offline; admin and payment records can sync when a connection returns. Do not put admin secrets or customer passwords in the browser bundle.

## 1. Paid shop provisioning and admin access

- [x] Add a separate admin sign-in and role checks backed by the server. Shopkeepers must never reach admin data by editing a client-side flag. Requires the Supabase setup in `ADMIN_SETUP.md`.
- [x] Record an admin-confirmed payment against a unique customer, shop, plan, amount, payment reference, and payment date. Support ₹2,999 yearly and ₹11,000 lifetime; distinguish received money from an unpaid enquiry.
- [x] After payment, let the admin create one customer account and issue a one-time temporary password. Require the owner to change it at first sign-in. Never send a permanent shared password.
- [x] Make that account work on the customer's phone through the cloud activation path.
- [x] Open the provisioned shop only after the owner changes the temporary password; keep existing-shop restore available. The first-week checklist guides product setup.
- [x] Keep an audit record of who created, activated, renewed, or disabled an account and when. The database trigger records account changes atomically; renewal and disable controls are still to be built.

## 2. Shopkeeper sign-in

- [ ] Offer clear **Email** and **Mobile number** choices. The current login uses only a local email and password; phone OTP exists for cloud recovery but is not a general sign-in method.
- [ ] Decide how mobile sign-in works offline after the first verification. Verify that SMS delivery, cost, phone changes, lost-phone recovery, and temporary-password setup work for pilot users.
- [ ] Test login, first password change, logout, PIN, backup restore, and new-phone recovery on a real low-cost Android phone.

## 3. Admin pilot dashboard

- [ ] Show customer shops, plan, activation date, last successful sync, last backup signal, and recent support status. Mark stale/offline data clearly; the admin cannot see an offline phone's live state.
- [ ] Show received revenue by period and plan, with manual payment corrections and refunds recorded separately. This is a sales ledger, not an accounting profit report.
- [ ] Show yearly renewals due soon, expired plans, lifetime plans, and follow-up reminders. Do not expire a customer solely because a phone is offline.
- [ ] Let the admin open one shop's support timeline: reported problems, call notes, actions taken, and resolution.

## 4. Feedback and support

- [ ] Add a simple in-app **Help / Report a problem** action in Hindi and English. Ask for a short description and optional callback number; show whether it was sent or is waiting offline.
- [ ] Show those reports in the admin dashboard with shop, time, status, owner, and reply/follow-up notes.
- [ ] Let the admin add feedback received by phone or in person to the same timeline, marked as an admin-entered note.

## 5. Failure monitoring

- [ ] Capture actionable failures in login, setup, sale saving, stock changes, backup, restore, and sync, with app version, route, time, device/browser, and a safe error code.
- [ ] Queue reports while offline and send them later. Give shopkeepers a reference code they can read out over the phone.
- [ ] Keep customer names, phone numbers, bill contents, passwords, and backup contents out of logs. Define retention and access for pilot support.
- [ ] Build an admin view for unresolved errors and repeat failures, linked to the support timeline where possible.

## 6. Launch flow and design checks

- [ ] Test the whole journey on a low-cost Android phone and slow/intermittent network: enquiry → verified manual payment → activation → first login → 5 real products → first sale → udhaar → day close → backup → new-phone recovery.
- [ ] Watch real target shopkeepers perform common tasks without instructions. Time each task, note mis-taps and unclear Hindi, and fix the biggest blockers before adding more features.
- [ ] Review screens, copy, icons, assets, and flows for originality against relevant market products. Replace any borrowed assets or close visual copies, and keep provenance for all third-party assets. Get a qualified legal review before making a legal-clearance claim.
- [ ] Keep large touch targets, readable Hindi, short forms, and visible save/failed/offline states.

## 7. Faster capture

- [ ] Add mobile-camera **barcode scanning** to sale and stock entry, with manual search always available. Measure speed and accuracy on low-cost phones and damaged labels.
- [ ] Explore photo-to-draft entry for incoming stock, supplier bills, and sales bills **after the MVP**. Keep AI camera out of the launch MVP as previously agreed. Any recognized item, quantity, price, and total must be shown for human correction before saving or billing.

## Order and launch boundary

Build items 1 and 2 before onboarding paid customers. Start a small pilot with manual payment verification and assisted setup. Add the support intake and minimum failure reporting next, then the admin dashboard. Run the full flow and originality review before wider launch. Barcode scanning can follow once core sale speed has been measured; photo recognition stays later.
