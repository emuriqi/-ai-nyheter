import { connection } from "next/server";
import { getDb } from "@/lib/db";

/** Enkel helsesjekk: svarer 200 når databasen kan leses. */
export async function GET() {
  await connection();
  try {
    await getDb().source.count();
    return Response.json({ ok: true, database: "ok" });
  } catch {
    return Response.json({ ok: false, database: "error" }, { status: 503 });
  }
}
