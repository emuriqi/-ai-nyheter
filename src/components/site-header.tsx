import Link from "next/link";
import { siteConfig } from "@/lib/config";

export function SiteHeader() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-4xl items-baseline justify-between gap-4 px-4 py-5">
        <Link href="/" className="font-serif text-2xl font-bold tracking-tight">
          {siteConfig.site.name}
        </Link>
        <p className="hidden text-sm text-muted sm:block">Nyheter skrevet av AI, kun fra åpne kilder</p>
      </div>
    </header>
  );
}
