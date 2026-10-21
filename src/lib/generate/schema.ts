import { z } from "zod";
import type { EditorialConfig } from "../config/schema";

/** Kategoriene en artikkel kan få. */
export const CATEGORIES = [
  "politikk",
  "økonomi",
  "arbeidsliv",
  "utdanning",
  "helse",
  "vær og klima",
  "miljø og energi",
  "samferdsel",
  "mat og landbruk",
  "kriminalitet",
  "ulykker",
  "internasjonalt",
  "kultur",
  "samfunn",
] as const;

export const PERSON_ROLES = ["offentlig_person", "privatperson"] as const;

/** Om artikkelen bare gjengir hva personen sier i sin rolle, eller sier noe om personen. */
export const PERSON_MENTIONS = ["uttaler_seg", "påstand_om_personen"] as const;

export const MODERATION_KINDS = [
  "udokumentert_påstand",
  "feil_gjengivelse",
  "tall_uten_kilde",
  "sitat",
  "kopiert_tekst",
  "privatperson",
  "personpåstand_med_for_få_kilder",
  "sensitivt_tema",
  "spekulasjon_eller_vurdering",
  "ubalansert",
  "annet",
] as const;

export const MODERATION_SEVERITIES = ["høy", "middels", "lav"] as const;

/**
 * JSON-skjemaet for artikkelen Claude skriver. Sendes uendret til API-et, så
 * strukturert output håndhever enum-verdiene (kategori og sensitive temaer
 * fra config/site.config.ts).
 */
export function articleJsonSchema(editorial: EditorialConfig) {
  return {
    type: "object",
    properties: {
      tittel: { type: "string" },
      ingress: { type: "string" },
      brodtekst: { type: "string" },
      kategori: { type: "string", enum: [...CATEGORIES] },
      sensitive_temaer: { type: "array", items: { type: "string", enum: [...editorial.sensitiveCategories] } },
      personer: {
        type: "array",
        items: {
          type: "object",
          properties: {
            navn: { type: "string" },
            rolle: { type: "string", enum: [...PERSON_ROLES] },
            omtale: { type: "string", enum: [...PERSON_MENTIONS] },
            kilder: { type: "array", items: { type: "string" } },
          },
          required: ["navn", "rolle", "omtale", "kilder"],
          additionalProperties: false,
        },
      },
      kilder_brukt: { type: "array", items: { type: "string" } },
      usikkerhet: { type: "array", items: { type: "string" } },
    },
    required: [
      "tittel",
      "ingress",
      "brodtekst",
      "kategori",
      "sensitive_temaer",
      "personer",
      "kilder_brukt",
      "usikkerhet",
    ],
    additionalProperties: false,
  };
}

export function articleParser(editorial: EditorialConfig) {
  const sensitive = z.string().refine((v) => editorial.sensitiveCategories.includes(v), "ukjent sensitivt tema");
  return z.object({
    tittel: z.string().trim().min(1),
    ingress: z.string().trim().min(1),
    brodtekst: z.string().trim().min(1),
    kategori: z.enum(CATEGORIES),
    sensitive_temaer: z.array(sensitive),
    personer: z.array(
      z.object({
        navn: z.string().trim().min(1),
        rolle: z.enum(PERSON_ROLES),
        omtale: z.enum(PERSON_MENTIONS),
        kilder: z.array(z.string()),
      }),
    ),
    kilder_brukt: z.array(z.string()),
    usikkerhet: z.array(z.string()),
  });
}

export type WrittenArticle = z.infer<ReturnType<typeof articleParser>>;

/** JSON-skjemaet for modereringen. */
export function moderationJsonSchema(editorial: EditorialConfig) {
  return {
    type: "object",
    properties: {
      vurdering: { type: "string", enum: ["ok", "flagget"] },
      funn: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: [...MODERATION_KINDS] },
            alvor: { type: "string", enum: [...MODERATION_SEVERITIES] },
            utdrag: { type: "string" },
            forklaring: { type: "string" },
          },
          required: ["type", "alvor", "utdrag", "forklaring"],
          additionalProperties: false,
        },
      },
      sensitive_temaer: { type: "array", items: { type: "string", enum: [...editorial.sensitiveCategories] } },
    },
    required: ["vurdering", "funn", "sensitive_temaer"],
    additionalProperties: false,
  };
}

export function moderationParser(editorial: EditorialConfig) {
  const sensitive = z.string().refine((v) => editorial.sensitiveCategories.includes(v), "ukjent sensitivt tema");
  return z.object({
    vurdering: z.enum(["ok", "flagget"]),
    funn: z.array(
      z.object({
        type: z.enum(MODERATION_KINDS),
        alvor: z.enum(MODERATION_SEVERITIES),
        utdrag: z.string(),
        forklaring: z.string(),
      }),
    ),
    sensitive_temaer: z.array(sensitive),
  });
}

export type ModerationOutput = z.infer<ReturnType<typeof moderationParser>>;
