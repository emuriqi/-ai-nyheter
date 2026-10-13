import { NextResponse, type NextRequest } from "next/server";
import { checkBasicAuth } from "@/lib/auth/basic-auth";

/**
 * Beskytter admin-sidene og admin-API-et med HTTP Basic Auth.
 * Datalaget sjekker i tillegg selv (requireAdmin() i src/lib/admin.ts), så
 * admin-data ikke lekker selv om en rute skulle gå utenom proxyen.
 */
export function proxy(request: NextRequest) {
  const result = checkBasicAuth(request.headers.get("authorization"), process.env.ADMIN_TOKEN);

  if (result === "ok") {
    return withFrameProtection(NextResponse.next());
  }
  if (result === "disabled") {
    return withFrameProtection(
      new NextResponse("Admin er avslått. Sett ADMIN_TOKEN til en tilfeldig verdi på minst 24 tegn i .env.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );
  }
  return withFrameProtection(
    new NextResponse("Krever innlogging.", {
      status: 401,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "WWW-Authenticate": 'Basic realm="AI-nyheter admin", charset="UTF-8"',
      },
    }),
  );
}

/**
 * Admin kan ikke vises i en ramme på et annet nettsted. Det hindrer at en
 * innlogget redaktør lures til å klikke på knapper i en skjult admin-side
 * (clickjacking). Basic Auth er ingen informasjonskapsel, så SameSite hjelper ikke.
 */
const FRAME_PROTECTION_HEADERS = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
} as const;

function withFrameProtection(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(FRAME_PROTECTION_HEADERS)) response.headers.set(name, value);
  return response;
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
