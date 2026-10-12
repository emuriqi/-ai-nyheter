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
    return NextResponse.next();
  }
  if (result === "disabled") {
    return new NextResponse("Admin er avslått. Sett ADMIN_TOKEN til en tilfeldig verdi på minst 24 tegn i .env.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return new NextResponse("Krever innlogging.", {
    status: 401,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate": 'Basic realm="AI-nyheter admin", charset="UTF-8"',
    },
  });
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
