/**
 * Høflig og avgrenset HTTP-henting.
 *
 * - Bare https.
 * - Identifiserende User-Agent med kontaktinformasjon.
 * - Tidsavbrudd og maks størrelse på svaret.
 * - Omdirigeringer følges bare innenfor tillatte verter, så en kilde ikke kan
 *   sende innhentingen videre til vilkårlige adresser.
 * - Hver adresse, også målet for en omdirigering, kan sjekkes mot robots.txt
 *   og TDM-regler før den hentes (`checkUrl`).
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type HttpOptions = {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  fetchImpl?: FetchLike;
  /** Verter omdirigeringer kan gå til. Standard: bare verten i URL-en. */
  allowedHosts?: string[];
  headers?: Record<string, string>;
  /**
   * Kalles før hver forespørsel, også for omdirigeringer. Returnerer en
   * begrunnelse når adressen ikke kan hentes, ellers null.
   */
  checkUrl?: (url: URL) => string | null;
};

export type HttpResult = {
  status: number;
  /** Endelig URL etter eventuelle omdirigeringer. */
  url: string;
  headers: Headers;
  body: string;
};

export class FetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

/** Adressen kan ikke hentes etter robots.txt eller TDM-reglene. */
export class AccessDeniedError extends FetchError {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

const MAX_REDIRECTS = 3;

export async function politeFetch(url: string, options: HttpOptions): Promise<HttpResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let current = parseHttpsUrl(url);
  const allowedHosts = new Set(options.allowedHosts ?? [current.host]);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const denied = options.checkUrl?.(current);
    if (denied) {
      throw new AccessDeniedError(denied, current.toString());
    }
    let response: Response;
    try {
      response = await fetchImpl(current.toString(), {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        headers: { "User-Agent": options.userAgent, ...options.headers },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new FetchError(`Tidsavbrudd etter ${options.timeoutMs} ms: ${current}`);
      }
      throw new FetchError(`Nettverksfeil mot ${current}: ${error instanceof Error ? error.message : error}`);
    }

    if (isRedirect(response.status)) {
      discard(response.body);
      const location = response.headers.get("location");
      if (!location) {
        throw new FetchError(`Omdirigering uten Location fra ${current}`, response.status);
      }
      const next = parseHttpsUrl(new URL(location, current).toString());
      if (!allowedHosts.has(next.host)) {
        throw new FetchError(`Omdirigering til en annen vert (${next.host}) er ikke tillatt`, response.status);
      }
      current = next;
      continue;
    }

    const body = response.status === 304 ? "" : await readLimited(response, options.maxBytes);
    return { status: response.status, url: current.toString(), headers: response.headers, body };
  }

  throw new FetchError(`For mange omdirigeringer fra ${url}`);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function parseHttpsUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FetchError(`Ugyldig URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new FetchError(`Bare https er tillatt: ${url}`);
  }
  return parsed;
}

/** Leser svaret, men avbryter hvis det blir større enn maxBytes. */
async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    discard(response.body);
    throw new FetchError(`Svaret er for stort (${declared} byte, maks ${maxBytes})`, response.status);
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => undefined);
      throw new FetchError(`Svaret er for stort (over ${maxBytes} byte)`, response.status);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decode(bytes, response.headers.get("content-type"));
}

/** Avbryter et svar vi ikke skal lese. Venter ikke, siden avbrudd kan henge på enkelte strømmer. */
function discard(body: ReadableStream<Uint8Array> | null): void {
  body?.cancel().catch(() => undefined);
}

/**
 * Dekoder med tegnsettet fra Content-Type, XML-deklarasjonen eller en
 * <meta charset> i starten av en HTML-side, ellers UTF-8.
 */
function decode(bytes: Uint8Array, contentType: string | null): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  const head = new TextDecoder("ascii").decode(bytes.subarray(0, 1024));
  const fromXml = /^\s*<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head)?.[1];
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  const charset = fromHeader ?? fromXml ?? fromMeta ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
