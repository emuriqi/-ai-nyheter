import { Suspense } from "react";
import { getAdminOverview } from "@/lib/admin";
import { siteConfig } from "@/lib/config";
import { formatDateTime } from "@/lib/format";
import {
  ARTICLE_STATUS_LABEL,
  JOB_STATUS_LABEL,
  JOB_TYPE_LABEL,
  SOURCE_STATUS_LABEL,
  label,
} from "@/lib/labels";

export default function AdminOverviewPage() {
  return (
    <div>
      <h1 className="font-serif text-2xl font-bold">Oversikt</h1>
      <Suspense fallback={<p className="mt-4 text-muted">Laster …</p>}>
        <Overview />
      </Suspense>
    </div>
  );
}

async function Overview() {
  const overview = await getAdminOverview();
  const { retention, editorial } = siteConfig;

  return (
    <div className="space-y-10">
      <section>
        <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Hentede elementer" value={overview.itemCount} />
          <Stat label="Med slettet kildetekst" value={overview.purgedCount} />
          <Stat label="Saker" value={overview.storyCount} />
          <Stat label="Venter på godkjenning" value={overview.pendingReviews} />
        </dl>
      </section>

      <section className="grid gap-8 sm:grid-cols-2">
        <div>
          <h2 className="font-semibold">Kilder</h2>
          <CountList counts={overview.sourcesByStatus} labels={SOURCE_STATUS_LABEL} />
        </div>
        <div>
          <h2 className="font-semibold">Artikler</h2>
          <CountList counts={overview.articlesByStatus} labels={ARTICLE_STATUS_LABEL} />
        </div>
      </section>

      <section>
        <h2 className="font-semibold">Juridiske innstillinger</h2>
        <p className="mt-1 text-sm text-muted">Fra config/site.config.ts</p>
        <ul className="mt-3 space-y-1 text-sm">
          <li>Kildetekst slettes etter {retention.sourceTextDays} dager</li>
          <li>
            Chatlogger: {retention.chatLogDays === 0 ? "lagres ikke" : `slettes etter ${retention.chatLogDays} dager`}
          </li>
          <li>
            Manuell godkjenning:{" "}
            {editorial.manualApproval === "ALL" ? "alle saker" : "bare saker som flagges"}
          </li>
          <li>Lengste tillatte sitat: {editorial.maxQuoteWords} ord</li>
        </ul>
      </section>

      <section>
        <h2 className="font-semibold">Siste jobber</h2>
        {overview.recentJobs.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Ingen jobber er kjørt ennå.</p>
        ) : (
          <table className="mt-3 w-full text-left text-sm">
            <thead className="text-muted">
              <tr>
                <th className="py-1 font-normal">Jobb</th>
                <th className="py-1 font-normal">Status</th>
                <th className="py-1 font-normal">Startet</th>
                <th className="py-1 font-normal">Utløst av</th>
              </tr>
            </thead>
            <tbody>
              {overview.recentJobs.map((job) => (
                <tr key={job.id} className="border-t border-border">
                  <td className="py-1">{label(JOB_TYPE_LABEL, job.type)}</td>
                  <td className="py-1">{label(JOB_STATUS_LABEL, job.status)}</td>
                  <td className="py-1">{formatDateTime(job.startedAt)}</td>
                  <td className="py-1">{job.trigger}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold">{value}</dd>
    </div>
  );
}

function CountList({ counts, labels }: { counts: Record<string, number>; labels: Record<string, string> }) {
  return (
    <ul className="mt-2 space-y-1 text-sm">
      {Object.keys(labels).map((key) => (
        <li key={key} className="flex justify-between border-b border-border py-1">
          <span>{labels[key]}</span>
          <span className="font-semibold">{counts[key] ?? 0}</span>
        </li>
      ))}
    </ul>
  );
}
