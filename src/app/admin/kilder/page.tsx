import type { Metadata } from "next";
import { Suspense } from "react";
import { getSourcesForAdmin } from "@/lib/admin";
import { formatDate, formatDateTime } from "@/lib/format";
import { LICENSE_LABEL, SOURCE_STATUS_LABEL, TDM_LABEL, label } from "@/lib/labels";

export const metadata: Metadata = { title: "Kilder" };

const STATUS_STYLE: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200",
  PAUSED: "bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200",
  NEEDS_VERIFICATION: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
};

export default function AdminSourcesPage() {
  return (
    <div>
      <h1 className="font-serif text-2xl font-bold">Kilder</h1>
      <p className="mt-2 text-sm text-muted">
        Kildelisten styres fra config/site.config.ts og synkroniseres med <code>npm run db:seed</code>. En
        kilde hentes bare når den er aktiv, og det krever åpen lisens, leste vilkår og at det ikke er
        funnet noen reservasjon mot tekst- og datautvinning.
      </p>
      <Suspense fallback={<p className="mt-6 text-muted">Laster …</p>}>
        <SourceList />
      </Suspense>
    </div>
  );
}

async function SourceList() {
  const sources = await getSourcesForAdmin();

  return (
    <>
      {sources.length === 0 ? (
        <p className="mt-6 rounded-lg border border-border p-6 text-muted">
          Ingen kilder i databasen. Kjør <code>npm run db:seed</code>.
        </p>
      ) : (
        <ul className="mt-6 space-y-4">
          {sources.map((source) => (
            <li key={source.id} className="rounded-lg border border-border p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">{source.name}</h2>
                <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[source.status] ?? ""}`}>
                  {label(SOURCE_STATUS_LABEL, source.status)}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted">
                {source.publisher} · {source.kind} · språk: {source.language}
              </p>
              <p className="mt-3 text-sm">{source.licenseNote}</p>
              <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <Row term="Lisens" value={label(LICENSE_LABEL, source.license)} />
                <Row term="Vilkår lest" value={formatDate(source.termsReviewedAt)} />
                <Row term="TDM-reservasjon" value={label(TDM_LABEL, source.tdmReservation)} />
                <Row
                  term="robots.txt"
                  value={
                    source.robotsCheckedAt
                      ? `${source.robotsAllowed ? "Tillatt" : "Blokkert"} (${formatDateTime(source.robotsCheckedAt)})`
                      : "Ikke sjekket"
                  }
                />
                <Row term="Henter lenket side" value={source.allowFullTextFetch ? "Ja" : "Nei"} />
                <Row term="Hentede elementer" value={String(source._count.items)} />
                <Row term="Sist hentet" value={formatDateTime(source.lastFetchedAt)} />
                <Row term="Kildeangivelse" value={source.attribution} />
              </dl>
              <p className="mt-3 flex flex-wrap gap-4 text-sm">
                <a href={source.termsUrl} className="text-accent hover:underline" rel="noopener noreferrer">
                  Vilkår
                </a>
                <a href={source.homepageUrl} className="text-accent hover:underline" rel="noopener noreferrer">
                  Nettsted
                </a>
                {source.feedUrl && <span className="break-all text-muted">Feed: {source.feedUrl}</span>}
              </p>
              {source.notes && <p className="mt-3 text-sm text-muted">Merknad: {source.notes}</p>}
              {source.lastFetchError && (
                <p className="mt-3 text-sm text-red-700 dark:text-red-400">Siste feil: {source.lastFetchError}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-muted">{term}:</dt>
      <dd>{value}</dd>
    </div>
  );
}
