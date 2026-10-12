import type { Metadata } from "next";
import { Suspense } from "react";
import { getRecentItemsForAdmin } from "@/lib/admin";
import { formatDate, formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Hentede elementer" };

export default function AdminItemsPage() {
  return (
    <div>
      <h1 className="font-serif text-2xl font-bold">Hentede elementer</h1>
      <p className="mt-2 text-sm text-muted">
        De nyeste elementene fra kildene. Kildeteksten vises ikke, bare hvor mye som er lagret og når den slettes.
      </p>
      <Suspense fallback={<p className="mt-6 text-muted">Laster …</p>}>
        <ItemList />
      </Suspense>
    </div>
  );
}

async function ItemList() {
  const items = await getRecentItemsForAdmin();

  if (items.length === 0) {
    return (
      <p className="mt-6 rounded-lg border border-border p-6 text-muted">
        Ingen elementer er hentet ennå. Elementer hentes bare fra kilder som er aktive i config/site.config.ts.
      </p>
    );
  }

  return (
    <div className="mt-6 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-muted">
          <tr>
            <th className="py-2 pr-4 font-normal">Tittel</th>
            <th className="py-2 pr-4 font-normal">Kilde</th>
            <th className="py-2 pr-4 font-normal">Publisert</th>
            <th className="py-2 pr-4 font-normal">Hentet</th>
            <th className="py-2 pr-4 font-normal">Lagret tekst</th>
            <th className="py-2 font-normal">Slettes</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-t border-border align-top">
              <td className="py-2 pr-4">
                <a href={item.url} className="text-accent hover:underline" rel="noopener noreferrer">
                  {item.title}
                </a>
              </td>
              <td className="py-2 pr-4">{item.source.name}</td>
              <td className="py-2 pr-4">{formatDateTime(item.publishedAt)}</td>
              <td className="py-2 pr-4">{formatDateTime(item.fetchedAt)}</td>
              <td className="py-2 pr-4">
                {item.purgedAt
                  ? "Slettet"
                  : `${item.excerptLength + item.bodyLength} tegn${item.bodyLength > 0 ? " (med brødtekst)" : ""}`}
              </td>
              <td className="py-2">{item.purgedAt ? formatDate(item.purgedAt) : formatDate(item.deleteAfter)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
