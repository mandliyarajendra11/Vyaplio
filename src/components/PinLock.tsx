"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { logout, verifyPassword } from "@/lib/auth";
import { db, type Shop } from "@/lib/db";
import { unlockApp } from "@/lib/lock";
import { pinWaitMs, removePin, verifyPin } from "@/lib/pin";
import { getCloudLink } from "@/lib/sync";
import { LangToggle } from "./LangToggle";
import { PinPad } from "./PinPad";
import { Wordmark } from "./Wordmark";

/** Full-screen lock shown instead of the app while a PIN is set and the app is locked. */
export function PinLock({ shop, userId }: { shop: Shop; userId: string }) {
  const t = useTranslations("pin");
  const router = useRouter();
  const [mode, setMode] = useState<"pin" | "forgot">("pin");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [waitUntil, setWaitUntil] = useState(0);
  const [clock, setClock] = useState(0);

  // A wait from earlier wrong tries survives a reload.
  useEffect(() => {
    let live = true;
    void pinWaitMs(userId).then((ms) => {
      if (!live || !ms) return;
      const now = Date.now();
      setClock(now);
      setWaitUntil(now + ms);
    });
    return () => {
      live = false;
    };
  }, [userId]);
  useEffect(() => {
    if (!waitUntil) return;
    const id = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [waitUntil]);

  const waitLeft = waitUntil > clock ? Math.ceil((waitUntil - clock) / 1000) : 0;
  const waiting = waitLeft > 0;

  const submit = async (pin: string) => {
    setBusy(true);
    try {
      const r = await verifyPin(userId, pin);
      if (r.ok) {
        unlockApp(userId);
        return;
      }
      if (r.waitMs) {
        const now = Date.now();
        setClock(now);
        setWaitUntil(now + r.waitMs);
        setMsg(r.reason === "wrong" ? t("wrongWait") : null);
      } else setMsg(t("wrong", { left: r.attemptsLeft }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-enter mx-auto flex min-h-dvh max-w-[560px] flex-col px-5 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]" data-testid="pin-lock">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Wordmark size="sm" sub={false} />
        <LangToggle />
      </div>
      <div className="mt-6 text-center">
        <p className="text-2xl font-bold break-words">{shop.name}</p>
        {shop.ownerName && <p className="text-ink-soft">{shop.ownerName}</p>}
      </div>
      {mode === "pin" ? (
        <div className="mt-6 flex flex-1 flex-col">
          <PinPad
            id="lock"
            label={t("title")}
            onComplete={submit}
            busy={busy || waiting}
            message={waiting ? t("wait", { sec: waitLeft }) : busy ? t("checking") : msg}
            tone={waiting || msg ? "error" : "info"}
          />
          <button type="button" className="mt-6 min-h-12 self-center px-4 font-semibold text-teal underline underline-offset-4" onClick={() => setMode("forgot")}>
            {t("forgot")}
          </button>
        </div>
      ) : (
        <ForgotPin
          userId={userId}
          onBack={() => setMode("pin")}
          onSignOut={() => {
            logout();
            router.replace("/login");
          }}
        />
      )}
    </div>
  );
}

function ForgotPin({ userId, onBack, onSignOut }: { userId: string; onBack: () => void; onSignOut: () => void }) {
  const t = useTranslations("pin");
  const user = useLiveQuery(() => db.users.get(userId), [userId]);
  const link = useLiveQuery(async () => (await getCloudLink()) ?? null, []);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reset = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (await verifyPassword(userId, password)) {
        await removePin(userId);
        unlockApp(userId);
      } else setError(t("badPassword"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-6 space-y-5" data-testid="forgot-pin">
      <h1 className="font-brand text-3xl font-semibold">{t("forgotTitle")}</h1>
      <form onSubmit={reset} className="card space-y-3 p-5">
        <p className="text-lg">{t("forgotIntro", { email: user?.email ?? "—" })}</p>
        <label className="label" htmlFor="forgot-pass">
          {t("password")}
        </label>
        <input id="forgot-pass" type="password" autoComplete="current-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && (
          <p role="alert" className="rounded-xl bg-brick/10 px-4 py-2 font-semibold text-brick">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-teal w-full" disabled={busy || !password}>
          {t("reset")}
        </button>
      </form>
      <section className="card space-y-2 border-brick/40 p-5" data-testid="forgot-nopass">
        <h2 className="text-xl font-bold">{t("noPassTitle")}</h2>
        <p className="font-semibold text-brick">{t("noPassBody")}</p>
        <ul className="list-disc space-y-1 pl-5">
          {link ? <li>{t("noPassCloud")}</li> : null}
          <li>{t("noPassFile")}</li>
          {!link && <li>{t("noPassNone")}</li>}
        </ul>
        <button type="button" className="btn btn-ghost w-full" onClick={onSignOut}>
          {t("signOut")}
        </button>
      </section>
      <button type="button" className="min-h-12 w-full font-semibold text-teal" onClick={onBack}>
        ← {t("backToPin")}
      </button>
    </div>
  );
}
