import { v4 as uuid } from "uuid";
import { db, type SaleDraft } from "./db";

export function emptySaleDraft(shopId: string): SaleDraft {
  return { shopId, id: uuid(), cart: {}, payment: "cash", customerId: "", newCust: null };
}

export async function saveSaleDraft(draft: SaleDraft) {
  await db.transaction("rw", [db.saleDrafts, db.sales], async () => {
    // A delayed write from a completed checkout must not resurrect its cart.
    if (await db.sales.get(draft.id)) return;
    await db.saleDrafts.put(draft);
  });
}
