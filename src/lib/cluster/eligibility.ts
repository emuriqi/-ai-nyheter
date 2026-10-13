import type { Prisma } from "@/generated/prisma/client";

/**
 * Elementer grupperingen kan analysere: tekst som fortsatt er lagret, fra en
 * aktiv kilde, og verken elementet eller kilden er reservert mot tekst- og
 * datautvinning. Samme filter gjelder for nye elementer, for elementene i åpne
 * saker (som kan sendes til Claude) og for ordvektene, så tekst som ikke kan
 * analyseres aldri brukes noe sted.
 */
export const ANALYZABLE_ITEM = {
  tdmReserved: false,
  purgedAt: null,
  source: {
    status: "ACTIVE",
    OR: [{ tdmReservationFound: null }, { tdmReservationFound: false }],
  },
} satisfies Prisma.SourceItemWhereInput;
