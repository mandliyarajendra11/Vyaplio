"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { LangToggle } from "@/components/LangToggle";
import { RestoreShopForm } from "@/components/RestoreShopForm";
import { Wordmark } from "@/components/Wordmark";

export default function RestorePage() {
  const t = useTranslations("restoreEntry");

  return (
    <main className="page-enter mx-auto min-h-dvh max-w-[560px] space-y-6 px-5 py-7">
      <div className="flex items-center justify-between gap-3">
        <Wordmark size="sm" sub={false} />
        <LangToggle />
      </div>
      <header>
        <h1 className="font-brand text-3xl font-bold">{t("title")}</h1>
        <p className="mt-2 text-lg text-ink-soft">{t("intro")}</p>
      </header>
      <section className="card space-y-4 p-5">
        <RestoreShopForm />
      </section>
      <Link href="/login" className="btn btn-ghost w-full">
        ← {t("back")}
      </Link>
    </main>
  );
}
