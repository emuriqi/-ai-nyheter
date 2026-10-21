import type { EditorialConfig } from "../config/schema";
import { type Finding, isBlocking, isFlagging, type Severity, sortFindings } from "./findings";
import type { ModerateOutcome } from "./claude";
import type { WrittenArticle } from "./schema";

export type Decision = {
  findings: Finding[];
  verdict: "OK" | "FLAGGED";
  /** Brudd på en fast regel: kan ikke publiseres før den er skrevet på nytt. */
  blocked: boolean;
  /** Publiseres uten manuell godkjenning (bare med manualApproval FLAGGED_ONLY og ingen funn som flagger). */
  autoPublish: boolean;
  sensitiveThemes: string[];
  /** Saken berører et sensitivt tema, ifølge skriveren eller moderatoren. */
  sensitive: boolean;
};

const SEVERITY_FROM_MODERATOR = { høy: "høy", middels: "middels", lav: "lav" } as const;

/**
 * Samler funnene fra de automatiske kontrollene, moderatoren og skriverens
 * egne opplysninger, og avgjør hva som skjer med artikkelen.
 *
 * - Sensitive temaer (Vær Varsom) flagger alltid, også når bare moderatoren
 *   melder dem som funn.
 * - En privatperson moderatoren mener er navngitt (alvor høy), stopper
 *   publisering. Mindre sikre funn om personer vurderes av redaktøren.
 * - Skriverens merknader om hull eller motstrid i kildene flagger.
 * - Kunne moderatoren ikke kjøre, flagges artikkelen.
 * - Med manualApproval ALL går alt til godkjenning uansett.
 */
export function decide(
  article: WrittenArticle,
  checks: Finding[],
  moderation: ModerateOutcome,
  editorial: EditorialConfig,
): Decision {
  const findings: Finding[] = [...checks];

  if (moderation.ok) {
    for (const f of moderation.result.funn) {
      findings.push({
        origin: "moderering",
        kind: f.type,
        severity: moderatorSeverity(f.type, f.alvor),
        message: f.forklaring,
        excerpt: f.utdrag || undefined,
      });
    }
  } else {
    findings.push({
      origin: "kontroll",
      kind: "moderering_mangler",
      severity: "høy",
      message: `Modereringen kunne ikke gjennomføres (${moderation.reason}). Artikkelen er bare kontrollert automatisk.`,
    });
  }

  const sensitiveThemes = [
    ...new Set([...article.sensitive_temaer, ...(moderation.ok ? moderation.result.sensitive_temaer : [])]),
  ];
  for (const theme of sensitiveThemes) {
    findings.push({
      origin: "skriver",
      kind: "sensitivt_tema",
      severity: "høy",
      message: `Saken berører et sensitivt tema (${theme}) og krever manuell godkjenning.`,
    });
  }
  for (const note of article.usikkerhet) {
    findings.push({ origin: "skriver", kind: "usikkerhet", severity: "middels", message: note });
  }
  const sensitive = findings.some((f) => f.kind === "sensitivt_tema");

  const flagged = findings.some(isFlagging) || (moderation.ok && moderation.result.vurdering === "flagget");
  return {
    findings: sortFindings(findings),
    verdict: flagged ? "FLAGGED" : "OK",
    blocked: isBlocking(findings),
    autoPublish: editorial.manualApproval === "FLAGGED_ONLY" && !flagged,
    sensitiveThemes,
    sensitive,
  };
}

/**
 * Alvorsgraden til et funn fra moderatoren. En privatperson moderatoren er
 * sikker på (høy), er brudd på en fast regel. Sensitive temaer flagger alltid.
 */
function moderatorSeverity(kind: string, alvor: keyof typeof SEVERITY_FROM_MODERATOR): Severity {
  if (kind === "privatperson") return alvor === "høy" ? "blokkerer" : "høy";
  if (kind === "sensitivt_tema") return "høy";
  return SEVERITY_FROM_MODERATOR[alvor];
}
