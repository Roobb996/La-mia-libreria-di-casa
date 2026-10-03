// Proxy CORS per "La mia libreria di casa" (Cloudflare Workers, piano gratuito).
//
// Inoltra solo richieste GET verso pochi siti di cataloghi di libri e aggiunge le
// intestazioni CORS che il browser richiede. Uso:  https://TUO-WORKER.workers.dev/?url=<indirizzo codificato>
//
// Facoltativo: crea il segreto GOOGLE_BOOKS_KEY (Settings -> Variables and Secrets)
// con una chiave API di Google Books per eliminare i "429 limite di richieste".

const ALLOWED_HOSTS = new Set([
  "opac.sbn.it",
  "www.googleapis.com",
  "openlibrary.org",
  "covers.openlibrary.org",
]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return new Response("Metodo non consentito", { status: 405, headers: CORS });

    const target = new URL(request.url).searchParams.get("url");
    let u;
    try { u = new URL(target); } catch { return new Response("Parametro url non valido", { status: 400, headers: CORS }); }

    if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) {
      return new Response("Sito non consentito", { status: 403, headers: CORS });
    }
    if (u.hostname === "www.googleapis.com" && env && env.GOOGLE_BOOKS_KEY) {
      u.searchParams.set("key", env.GOOGLE_BOOKS_KEY);
    }

    const upstream = await fetch(u.toString(), {
      headers: { Accept: "application/json", "User-Agent": "libreria-di-casa/1.0" },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });

    const headers = new Headers(CORS);
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
    headers.set("Cache-Control", "public, max-age=3600");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
