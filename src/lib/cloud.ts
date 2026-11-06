import { ensureLocalUser, ensureLocalUserAfterPhoneRecovery } from "./auth";
import { enqueueSnapshot, wipeShopData } from "./backup";
import { db, shopTables, type Shop } from "./db";
import { setLocale, setSession } from "./prefs";
import { getSupabase } from "./supabase/client";
import { indiaPhone, phoneLocalAccount } from "./phone";
import { SyncError, contextFor, getCloudLink, pull, setCloudLink, syncFresh, type CloudLink } from "./sync";

/*
 * Cloud account (Supabase Auth) on top of the local-first app. Without keys none of this runs
 * and the app stays fully local. A local account can be linked to a cloud account at any time.
 */

function client() {
  const sb = getSupabase();
  if (!sb) throw new SyncError("notConfigured");
  return sb;
}
const authError = (e: { message?: string; status?: number } | null) => {
  const m = e?.message ?? "";
  if (/invalid login|invalid credentials|email not confirmed/i.test(m)) return new SyncError("auth", m);
  if (/fetch|network/i.test(m)) return new SyncError("network", m);
  return new SyncError("server", m);
};

export type CloudUser = { id: string; email: string; phone?: string };

export async function cloudUser(): Promise<CloudUser | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  const u = data.session?.user;
  return u ? { id: u.id, email: u.email ?? "", phone: u.phone ?? undefined } : null;
}

/** Create a cloud account. Returns `confirm: true` when Supabase wants the email confirmed first. */
export async function cloudSignUp(email: string, password: string): Promise<{ user: CloudUser | null; confirm: boolean }> {
  const { data, error } = await client().auth.signUp({ email: email.trim().toLowerCase(), password });
  if (error) throw authError(error);
  const u = data.session?.user;
  return { user: u ? { id: u.id, email: u.email ?? "" } : null, confirm: !data.session };
}

export async function cloudSignIn(email: string, password: string): Promise<CloudUser> {
  const { data, error } = await client().auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
  if (error || !data.session) throw authError(error);
  return { id: data.session.user.id, email: data.session.user.email ?? "", phone: data.session.user.phone ?? undefined };
}

/** Phone OTP needs Supabase Phone Auth and an SMS provider. Recovery never creates an empty account. */
export async function cloudSendPhoneOtp(input: string, createUser = false) {
  const phone = indiaPhone(input);
  if (!phone) throw new SyncError("auth", "phoneInvalid");
  const { error } = await client().auth.signInWithOtp({ phone, options: { shouldCreateUser: createUser } });
  if (error) throw authError(error);
  return phone;
}
export async function cloudVerifyPhoneOtp(phone: string, token: string): Promise<CloudUser> {
  if (!indiaPhone(phone) || !/^\d{6,8}$/.test(token.trim())) throw new SyncError("auth", "otpInvalid");
  const { data, error } = await client().auth.verifyOtp({ phone, token, type: "sms" });
  if (error || !data.session) throw authError(error);
  return { id: data.session.user.id, email: data.session.user.email ?? "", phone: data.session.user.phone ?? undefined };
}

/** Attach a recovery number to the *current* cloud user, not a second account. */
export async function cloudStartPhoneLink(input: string, expectedUid: string) {
  const phone = indiaPhone(input);
  if (!phone) throw new SyncError("auth", "phoneInvalid");
  const before = await cloudUser();
  if (!before) throw new SyncError("signedOut");
  if (before.id !== expectedUid) throw new SyncError("auth", "wrongCloudAccount");
  const { error } = await client().auth.updateUser({ phone });
  if (error) throw authError(error);
  return { phone, uid: before.id };
}

export async function cloudFinishPhoneLink(phone: string, token: string, uid: string) {
  if (!indiaPhone(phone) || !/^\d{6,8}$/.test(token.trim())) throw new SyncError("auth", "otpInvalid");
  const { error } = await client().auth.verifyOtp({ phone, token, type: "phone_change" });
  if (error) throw authError(error);
  const { data: refreshed, error: refreshError } = await client().auth.getUser();
  if (refreshError) throw authError(refreshError);
  const after = refreshed.user ? { id: refreshed.user.id, email: refreshed.user.email ?? "", phone: refreshed.user.phone ?? undefined } : null;
  if (!after || after.id !== uid || after.phone !== phone) throw new SyncError("auth", "phoneLinkMismatch");
  return after;
}

/** Sign out of the cloud only; this phone's data and local account stay. */
export async function cloudSignOut() {
  await getSupabase()?.auth.signOut({ scope: "local" });
  await setCloudLink(null);
}

async function cloudShops(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await client().from("shops").select("id,name").limit(2);
  if (error) throw new SyncError(/jwt|token/i.test(error.message) ? "auth" : "server", error.message);
  return data ?? [];
}

/**
 * Link this phone's shop to the signed-in cloud account and upload everything.
 * If the account already holds a different shop, nothing changes and `conflict` is returned.
 */
export async function linkShop(shop: Shop, localUserId: string): Promise<{ status: "linked" } | { status: "conflict"; cloudShop: { id: string; name: string } }> {
  if (shop.isDemo) throw new SyncError("demo");
  const user = await cloudUser();
  if (!user) throw new SyncError("signedOut");
  const other = (await cloudShops()).find((s) => s.id !== shop.id);
  if (other) return { status: "conflict", cloudShop: other };
  await setCloudLink({ localUserId, shopId: shop.id, uid: user.id, email: user.email, linkedAt: Date.now() });
  await enqueueSnapshot(shop.id);
  const r = await syncFresh({ full: true });
  if (r.error) throw r.error;
  return { status: "linked" };
}

async function pullInto(link: CloudLink) {
  const ctx = await contextFor(link);
  await pull(ctx, { full: true, ownerId: link.localUserId });
}

/**
 * New phone: sign in to the cloud, download the whole shop and open it.
 * Creates (or re-uses) a local account with the same email + password.
 */
export async function recoverFromCloud(email: string, password: string): Promise<Shop> {
  const user = await cloudSignIn(email, password);
  return recoverSignedIn(user, email, password, false);
}

/** OTP proves the cloud identity; a new local password keeps the recovered phone usable offline. */
export async function recoverFromCloudPhone(phone: string, token: string, localPassword: string): Promise<Shop> {
  if (localPassword.length < 6) throw new SyncError("auth", "passwordShort");
  const user = await cloudVerifyPhoneOtp(phone, token);
  return recoverSignedIn(user, user.email || phoneLocalAccount(phone), localPassword, true);
}

async function recoverSignedIn(user: CloudUser, email: string, password: string, phoneVerified: boolean): Promise<Shop> {
  const shops = await cloudShops();
  if (!shops.length) throw new SyncError("noCloudShop");
  const existing = await db.users.where("email").equals(email.trim().toLowerCase()).first();
  const previous = existing ? await db.shops.where("ownerId").equals(existing.id).first() : null;
  if (previous && previous.id !== shops[0].id) throw new SyncError("conflict", previous.name);
  const local = phoneVerified ? await ensureLocalUserAfterPhoneRecovery(email, password) : await ensureLocalUser(email, password);
  const mine = await db.shops.where("ownerId").equals(local.id).first();
  if (mine && mine.id !== shops[0].id) throw new SyncError("conflict", mine.name);
  const link: CloudLink = { localUserId: local.id, shopId: shops[0].id, uid: user.id, email: user.email, linkedAt: Date.now() };
  await pullInto(link);
  await setCloudLink(link);
  const shop = await db.shops.get(link.shopId);
  if (!shop) throw new SyncError("noCloudShop");
  setLocale(shop.language);
  setSession(local.id);
  return shop;
}

/**
 * The cloud account holds a different shop than this phone: replace this phone's shop with the
 * cloud one (the caller offers a backup file first).
 */
export async function replaceWithCloudShop(localUserId: string, currentShopId: string | undefined) {
  const user = await cloudUser();
  if (!user) throw new SyncError("signedOut");
  const shops = await cloudShops();
  if (!shops.length) throw new SyncError("noCloudShop");
  if (currentShopId)
    await db.transaction("rw", [...shopTables(), db.meta], () =>
      wipeShopData(currentShopId),
    );
  const link: CloudLink = { localUserId, shopId: shops[0].id, uid: user.id, email: user.email, linkedAt: Date.now() };
  await pullInto(link);
  await setCloudLink(link);
}

export { getCloudLink };
