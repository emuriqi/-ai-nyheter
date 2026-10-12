import { NextResponse, type NextRequest } from "next/server";
import { checkBasicAuth } from "@/lib/auth/basic-auth";

/**
 * Beskytter admin-sidene og admin-API-et med HTTP Basic Auth.
 * Sidene sjekker i tillegg selv (se src/lib/auth/require-admin.ts), så
 * tilgangskontrollen ikke avhenger av proxyen alene.
 */
export function proxy(request: NextRequest) {
  const result = checkBasicAuth(request.headers.get("authorization"), process.env.ADMIN_TOKEN);

  if (result === "ok") {
    return NextResponse.next();
  }
  if (result === "disabled") {
    return new NextResponse("Admin er avslått. Sett ADMIN_TOKEN (minst 12 tegn) i .env.", {
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
