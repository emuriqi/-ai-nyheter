import type { Metadata } from "next";
import Link from "next/link";
import { siteConfig } from "@/lib/config";

export const metadata: Metadata = {
  title: { default: "Admin", template: `%s · Admin · ${siteConfig.site.name}` },
  robots: { index: false, follow: false },
};

// Layouten gir ikke tilgangskontroll. Den ligger i proxyen og i datalaget
// (src/lib/admin.ts kaller requireAdmin()).
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
        <Link href="/admin/elementer" className="hover:underline">
          Hentede elementer
        </Link>
        <Link href="/admin/saker" className="hover:underline">
          Saker
        </Link>
      </nav>
      {children}
    </div>
  );
}
