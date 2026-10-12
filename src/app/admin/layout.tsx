import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { requireAdmin } from "@/lib/auth/require-admin";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <div>
      <nav aria-label="Admin" className="mb-8 flex gap-6 border-b border-border pb-3 text-sm">
        <span className="font-semibold">Admin</span>
        <Link href="/admin" className="hover:underline">
          Oversikt
        </Link>
        <Link href="/admin/kilder" className="hover:underline">
          Kilder
        </Link>
      </nav>
      <Suspense fallback={<p className="text-muted">Laster …</p>}>
        <AdminGate>{children}</AdminGate>
      </Suspense>
    </div>
  );
}

/** Sjekker tilgang på serveren før noe admin-innhold rendres. */
async function AdminGate({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return children;
}
