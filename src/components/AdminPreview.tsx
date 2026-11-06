"use client";

import Link from "next/link";
import { useState } from "react";
import { Wordmark } from "@/components/Wordmark";
import { formatINR } from "@/lib/money";

type Tab = "overview" | "shops" | "support" | "money" | "errors" | "history" | "new";
type Shop = { id: string; name: string; owner: string; type: string; plan: "Yearly" | "Lifetime"; state: string; paid: number; due: string | null; lastSync: string; backup: string };
type Ticket = { id: string; shopId: string; channel: "App" | "Call"; title: string; note: string; state: "Open" | "Following up" | "Resolved"; time: string };

const today = "6 Nov 2026";
const initialShops: Shop[] = [
  { id: "s1", name: "Sharma Kirana", owner: "Ramesh Sharma", type: "Kirana", plan: "Yearly", state: "Active", paid: 2999, due: "20 Nov 2026", lastSync: "Today, 10:40 am", backup: "Yesterday" },
  { id: "s2", name: "Gupta Medical", owner: "Anita Gupta", type: "Medical", plan: "Lifetime", state: "Active", paid: 11000, due: null, lastSync: "Today, 9:15 am", backup: "3 days ago" },
  { id: "s3", name: "Colour House", owner: "Imran Khan", type: "Paint", plan: "Yearly", state: "Needs renewal", paid: 2999, due: "2 Nov 2026", lastSync: "4 days ago", backup: "12 days ago" },
  { id: "s4", name: "City Stationery", owner: "Suman Patil", type: "Stationery", plan: "Yearly", state: "Awaiting activation", paid: 2999, due: "6 Nov 2027", lastSync: "Not yet", backup: "Not yet" },
];
const initialTickets: Ticket[] = [
  { id: "SUP-104", shopId: "s1", channel: "App", title: "Sale did not save", note: "Owner pressed Save during weak network. Check whether a bill was created before retrying.", state: "Open", time: "Today, 10:42 am" },
  { id: "SUP-103", shopId: "s3", channel: "Call", title: "Renewal question", note: "Owner asked about the yearly plan on the phone. Call back after checking the payment reference.", state: "Following up", time: "Yesterday, 4:20 pm" },
  { id: "SUP-102", shopId: "s2", channel: "App", title: "How to add expiry date?", note: "Explained stock edit and expiry alerts.", state: "Resolved", time: "4 Nov, 12:10 pm" },
];
const logs = [
  { id: "ERR-208", shopId: "s1", code: "SALE_SAVE_RETRY", area: "Sale", time: "Today, 10:41 am", status: "Needs review", detail: "Save was interrupted. Confirm whether a bill exists before asking the owner to try again." },
  { id: "ERR-207", shopId: "s3", code: "SYNC_OFFLINE", area: "Sync", time: "Today, 9:05 am", status: "Waiting for internet", detail: "Changes remain on the phone and will retry when it reconnects." },
  { id: "ERR-206", shopId: "s2", code: "BACKUP_CANCELLED", area: "Backup", time: "Yesterday, 6:30 pm", status: "Informational", detail: "The owner closed the file share sheet before saving a copy." },
];
const tabs: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" }, { id: "shops", label: "Shops" }, { id: "support", label: "Feedback & calls" },
  { id: "money", label: "Money & renewals" }, { id: "errors", label: "Error log" }, { id: "history", label: "Account history" },
  { id: "new", label: "New shop" },
];

function StateBadge({ value }: { value: string }) {
  const tone = value === "Active" || value === "Resolved" ? "bg-leaf/10 text-leaf" : value === "Open" || value === "Needs renewal" || value === "Needs review" ? "bg-brick/10 text-brick" : "bg-mustard/25 text-mustard-ink";
  return <span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${tone}`}>{value}</span>;
}

export function AdminPreview() {
  const [tab, setTab] = useState<Tab>("overview");
  const [shops, setShops] = useState(initialShops);
  const [tickets, setTickets] = useState(initialTickets);
  const [selectedShop, setSelectedShop] = useState("s1");
  const [selectedTicket, setSelectedTicket] = useState("SUP-104");
  const [search, setSearch] = useState("");
  const [callShop, setCallShop] = useState("s1");
  const [callNote, setCallNote] = useState("");
  const [form, setForm] = useState({ shop: "", owner: "", email: "", plan: "Yearly", reference: "", verified: false });
  const [notice, setNotice] = useState("");
  const [followedUp, setFollowedUp] = useState<string[]>([]);
  const shopName = (id: string) => shops.find((shop) => shop.id === id)?.name ?? "Sample shop";
  const paid = shops.reduce((sum, shop) => sum + shop.paid, 0);
  const due = shops.filter((shop) => shop.due && (shop.state === "Needs renewal" || shop.due.includes("Nov 2026")));
  const openTickets = tickets.filter((ticket) => ticket.state !== "Resolved");
  const filtered = shops.filter((shop) => `${shop.name} ${shop.owner} ${shop.type}`.toLowerCase().includes(search.toLowerCase()));
  const currentShop = shops.find((shop) => shop.id === selectedShop);
  const currentTicket = tickets.find((ticket) => ticket.id === selectedTicket);

  const addCallNote = () => {
    const note = callNote.trim();
    if (!note) return;
    const id = `SUP-P${tickets.length + 1}`;
    setTickets([{ id, shopId: callShop, channel: "Call", title: "Call note", note, state: "Open", time: today }, ...tickets]);
    setSelectedTicket(id); setCallNote(""); setNotice("Sample call note added to this preview only.");
  };
  const addSampleShop = () => {
    if (!form.shop.trim() || !form.email.trim() || !form.reference.trim() || !form.verified) return;
    const id = `sample-${shops.length + 1}`;
    setShops([...shops, { id, name: form.shop.trim(), owner: form.owner.trim() || "Sample owner", type: "Other", plan: form.plan as Shop["plan"], state: "Awaiting activation", paid: form.plan === "Yearly" ? 2999 : 11000, due: form.plan === "Yearly" ? "6 Nov 2027" : null, lastSync: "Not yet", backup: "Not yet" }]);
    setSelectedShop(id); setForm({ shop: "", owner: "", email: "", plan: "Yearly", reference: "", verified: false });
    setNotice("Sample shop added in this preview. No account, payment, or password was created."); setTab("shops");
  };

  return <main className="page-enter mx-auto min-h-dvh max-w-[1120px] space-y-5 px-4 py-6 sm:px-6 lg:px-10">
    <div className="flex flex-wrap items-center justify-between gap-3"><Wordmark size="sm" sub={false} /><Link className="btn btn-ghost" href="/login">← Back to login</Link></div>
    <div className="rounded-2xl border-2 border-mustard-deep bg-mustard/15 p-4" role="status"><p className="font-bold">Local admin preview · sample data</p><p className="text-sm text-ink-soft">Explore the intended screens. Changes here stay in this browser preview. No customer account, payment, message, or server log is created.</p></div>
    <header><h1 className="font-brand text-[clamp(2rem,7vw,3rem)] font-semibold">Pilot dashboard</h1><p className="text-ink-soft">A clear view of shops, follow-ups, money, and problems that need your help.</p></header>
    <nav aria-label="Admin sections" className="flex flex-wrap gap-2 pb-2">{tabs.map((item) => <button key={item.id} type="button" onClick={() => { setTab(item.id); setNotice(""); }} aria-current={tab === item.id ? "page" : undefined} className={`min-h-12 rounded-full border-2 px-4 font-bold ${tab === item.id ? "border-teal bg-teal text-paper" : "border-line bg-card"}`}>{item.label}</button>)}</nav>
    {notice && <p role="status" className="rounded-xl bg-leaf/10 p-3 font-semibold text-leaf">{notice}</p>}

    {tab === "overview" && <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><div className="card p-4"><p className="text-ink-soft">Customer shops</p><p className="num text-3xl font-bold">{shops.length}</p></div><div className="card p-4"><p className="text-ink-soft">Payments recorded</p><p className="num text-3xl font-bold">{formatINR(paid)}</p></div><div className="card p-4"><p className="text-ink-soft">Renewal follow-ups</p><p className="num text-3xl font-bold">{due.length}</p></div><div className="card p-4"><p className="text-ink-soft">Open support</p><p className="num text-3xl font-bold">{openTickets.length}</p></div></div>
      <div className="grid gap-4 lg:grid-cols-2"><section className="card space-y-3 p-5"><h2 className="text-xl font-bold">Needs attention</h2><button className="w-full rounded-xl bg-brick/10 p-3 text-left font-semibold" onClick={() => setTab("errors")}>1 sale save needs review →</button><button className="w-full rounded-xl bg-mustard/20 p-3 text-left font-semibold" onClick={() => setTab("money")}>{due.length} yearly renewals to follow up →</button><button className="w-full rounded-xl bg-paper-2 p-3 text-left font-semibold" onClick={() => setTab("support")}>{openTickets.length} customer conversations open →</button></section><section className="card space-y-3 p-5"><h2 className="text-xl font-bold">Recent activity</h2><p className="border-b border-line pb-2">Sale issue reported · {shopName("s1")}</p><p className="border-b border-line pb-2">Phone call recorded · {shopName("s3")}</p><p>New shop awaiting first login · {shopName("s4")}</p></section></div>
      <p className="text-sm text-ink-soft">Last sync tells you when the phone last reached the cloud. An offline shop may have newer work that is not visible here.</p>
    </div>}

    {tab === "shops" && <div className="grid gap-4 lg:grid-cols-[1fr_0.85fr]"><section className="card p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-bold">Customer shops</h2><button className="btn btn-teal" onClick={() => setTab("new")}>+ New shop</button></div><label className="mt-4 block"><span className="sr-only">Search shops</span><input className="input" placeholder="Search shop, owner, or type" value={search} onChange={(e) => setSearch(e.target.value)} /></label><ul className="mt-3 divide-y divide-line">{filtered.map((shop) => <li key={shop.id}><button className="w-full py-4 text-left" onClick={() => setSelectedShop(shop.id)}><span className="flex flex-wrap items-center justify-between gap-2"><span className="font-bold">{shop.name}</span><StateBadge value={shop.state} /></span><span className="mt-1 block text-sm text-ink-soft">{shop.type} · {shop.owner} · {shop.plan}</span></button></li>)}</ul>{!filtered.length && <p className="py-4 text-ink-soft">No matching shops.</p>}</section>{currentShop && <section className="card space-y-3 p-5"><h2 className="text-xl font-bold">{currentShop.name}</h2><p>{currentShop.owner} · {currentShop.type}</p><p><strong>Plan:</strong> {currentShop.plan} · <StateBadge value={currentShop.state} /></p><p><strong>Renewal:</strong> {currentShop.due ?? "No yearly renewal"}</p><p><strong>Last sync:</strong> {currentShop.lastSync}</p><p><strong>Last backup signal:</strong> {currentShop.backup}</p><p className="rounded-xl bg-paper-2 p-3 text-sm">These are sample support signals. An offline phone can have newer data.</p><button className="btn btn-ghost w-full" onClick={() => { setCallShop(currentShop.id); setTab("support"); }}>Open support / add call note</button></section>}</div>}

    {tab === "support" && <div className="grid gap-4 lg:grid-cols-[1fr_0.85fr]"><section className="card p-5"><h2 className="text-xl font-bold">Feedback and call notes</h2><p className="mt-1 text-sm text-ink-soft">App reports and calls share one follow-up list.</p><ul className="mt-3 divide-y divide-line">{tickets.map((ticket) => <li key={ticket.id}><button className="w-full py-4 text-left" onClick={() => setSelectedTicket(ticket.id)}><span className="flex flex-wrap items-center justify-between gap-2"><span className="font-bold">{ticket.title}</span><StateBadge value={ticket.state} /></span><span className="mt-1 block text-sm text-ink-soft">{ticket.id} · {shopName(ticket.shopId)} · {ticket.channel} · {ticket.time}</span></button></li>)}</ul></section><div className="space-y-4">{currentTicket && <section className="card space-y-3 p-5"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-xl font-bold">{currentTicket.title}</h2><StateBadge value={currentTicket.state} /></div><p className="text-sm text-ink-soft">{currentTicket.id} · {shopName(currentTicket.shopId)} · {currentTicket.channel}</p><p>{currentTicket.note}</p><label className="block"><span className="label">Follow-up status</span><select className="input" value={currentTicket.state} onChange={(e) => { const state = e.target.value as Ticket["state"]; setTickets(tickets.map((item) => item.id === currentTicket.id ? { ...item, state } : item)); setNotice("Status changed in this preview only."); }}><option>Open</option><option>Following up</option><option>Resolved</option></select></label></section>}<section className="card space-y-3 p-5"><h2 className="text-xl font-bold">Add a call note</h2><label className="block"><span className="label">Shop</span><select className="input" value={callShop} onChange={(e) => setCallShop(e.target.value)}>{shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}</select></label><label className="block"><span className="label">What did the owner say?</span><textarea className="input min-h-28" value={callNote} onChange={(e) => setCallNote(e.target.value)} placeholder="Short note, question, or promise to call back" /></label><button className="btn btn-teal w-full" onClick={addCallNote} disabled={!callNote.trim()}>Add sample note</button></section></div></div>}

    {tab === "money" && <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-3"><div className="card p-4"><p className="text-ink-soft">Received from sample plans</p><p className="num text-3xl font-bold">{formatINR(paid)}</p></div><div className="card p-4"><p className="text-ink-soft">Yearly payments</p><p className="num text-3xl font-bold">{formatINR(shops.filter((s) => s.plan === "Yearly").reduce((n, s) => n + s.paid, 0))}</p></div><div className="card p-4"><p className="text-ink-soft">Lifetime payments</p><p className="num text-3xl font-bold">{formatINR(shops.filter((s) => s.plan === "Lifetime").reduce((n, s) => n + s.paid, 0))}</p></div></div><section className="card p-5"><h2 className="text-xl font-bold">Renewals to follow up</h2><ul className="mt-3 divide-y divide-line">{due.map((shop) => <li key={shop.id} className="flex flex-wrap items-center justify-between gap-3 py-4"><div><p className="font-bold">{shop.name}</p><p className="text-sm text-ink-soft">{shop.due} · {shop.owner}</p></div><button className="btn btn-ghost" onClick={() => { setFollowedUp([...followedUp, shop.id]); setNotice("Follow-up marked in this preview only. No message was sent."); }} disabled={followedUp.includes(shop.id)}>{followedUp.includes(shop.id) ? "Marked for follow-up" : "Mark follow-up"}</button></li>)}</ul></section><section className="card p-5"><h2 className="text-xl font-bold">Payments recorded</h2><ul className="mt-3 divide-y divide-line">{shops.map((shop) => <li key={shop.id} className="flex flex-wrap justify-between gap-2 py-3"><span>{shop.name} · {shop.plan}</span><strong className="num">{formatINR(shop.paid)}</strong></li>)}</ul><p className="mt-3 text-sm text-ink-soft">This is plan revenue received, not business profit. Refunds and corrections need their own records in the real system.</p></section></div>}

    {tab === "errors" && <section className="card p-5"><h2 className="text-xl font-bold">Failure log</h2><p className="mt-1 text-sm text-ink-soft">Safe codes and timestamps only. No bill contents, passwords, or customer details.</p><ul className="mt-4 divide-y divide-line">{logs.map((entry) => <li key={entry.id} className="py-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-bold">{entry.area} · {entry.code}</p><StateBadge value={entry.status} /></div><p className="mt-1 text-sm text-ink-soft">{entry.id} · {shopName(entry.shopId)} · {entry.time}</p><p className="mt-2">{entry.detail}</p><button className="mt-2 font-bold text-teal underline underline-offset-4" onClick={() => { setCallShop(entry.shopId); setTab("support"); }}>Add support follow-up →</button></li>)}</ul></section>}

    {tab === "history" && <section className="card p-5"><h2 className="text-xl font-bold">Account history</h2><p className="mt-1 text-sm text-ink-soft">Who changed access and when. These examples are sample data.</p><ul className="mt-4 divide-y divide-line"><li className="py-4"><p className="font-bold">Created · City Stationery</p><p className="text-sm text-ink-soft">Admin · Today, 11:20 am</p></li><li className="py-4"><p className="font-bold">Activated · Gupta Medical</p><p className="text-sm text-ink-soft">Shop owner · 4 Nov, 9:30 am</p></li><li className="py-4"><p className="font-bold">Created · Colour House</p><p className="text-sm text-ink-soft">Admin · 2 Nov, 3:15 pm</p></li></ul></section>}

    {tab === "new" && <section className="card max-w-[760px] space-y-4 p-5"><h2 className="text-xl font-bold">Create a paid shop</h2><p className="text-ink-soft">In the real admin flow, confirm payment first. This preview will add only a sample row.</p><div className="grid gap-4 sm:grid-cols-2"><label className="block"><span className="label">Shop name</span><input className="input" value={form.shop} onChange={(e) => setForm({ ...form, shop: e.target.value })} /></label><label className="block"><span className="label">Owner name</span><input className="input" value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} /></label><label className="block"><span className="label">Email</span><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label className="block"><span className="label">Plan</span><select className="input" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}><option>Yearly</option><option>Lifetime</option></select></label><label className="block sm:col-span-2"><span className="label">Payment reference</span><input className="input" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></label></div><label className="flex items-center gap-3 font-semibold"><input type="checkbox" className="h-6 w-6 accent-teal" checked={form.verified} onChange={(e) => setForm({ ...form, verified: e.target.checked })} />I checked that payment arrived.</label><button className="btn btn-primary w-full sm:w-auto" disabled={!form.shop.trim() || !form.email.trim() || !form.reference.trim() || !form.verified} onClick={addSampleShop}>Add sample shop</button></section>}
  </main>;
}
