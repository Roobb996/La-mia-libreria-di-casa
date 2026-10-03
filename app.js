// Libreria personale
(function () {
  "use strict";

  const STORAGE_KEY = "riga.books.v1";
  const FLAGS = {
    da_leggere: "Da leggere",
    in_lettura: "In lettura",
    letto: "Letto",
    prestato: "Prestato",
    preferito: "Preferito",
  };
  const FILTERS = {
    prestato: "Prestati",
    letto: "Letti",
    da_leggere: "Da leggere",
    preferito: "Preferiti",
  };
  const MONTHS = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];

  let books = [];
  const activeFilters = new Set();
  let search = "";

  // ---------- utils ----------
  const $ = (s, r = document) => r.querySelector(s);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function shortDate(iso) {
    const d = new Date(iso);
    return iso && !isNaN(d) ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : "";
  }
  function longDate(iso) {
    const d = new Date(iso);
    return iso && !isNaN(d) ? d.toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" }) : "";
  }

  // ---------- storage ----------
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(parsed)) return null;
      return parsed.map((b) => {
        const { status, ...rest } = b;
        return { ...rest, flags: Array.isArray(b.flags) ? b.flags : status ? [status] : [] };
      });
    } catch {
      return null;
    }
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(books)); } catch {}
  }
  function seed() {
    return [
      { id: uid(), title: "La casa degli spiriti", author: "Isabel Allende", year: "1982", flags: ["prestato", "letto", "preferito"], lentTo: "Marco", returnDate: "2026-10-12", rating: 5, review: "Ho riletto questo libro tre volte. La voce di Clara mi accompagna ancora, e ogni volta scopro un dettaglio che prima mi sfuggiva. È il tipo di storia che resta addosso come un profumo.", feeling: "Nostalgica", feelingTags: ["tenera", "inquieta"], dateRead: "2026-08-14" },
      { id: uid(), title: "Normal People", author: "Sally Rooney", year: "2018", flags: ["letto"], rating: 4, review: "Due persone che si sbagliano tutto il tempo, e io che gli grido dietro da ogni pagina. Il dialogo è chirurgico: non c'è una parola di troppo.", feeling: "Vista", feelingTags: ["scomoda", "intima"], dateRead: "2026-03-21" },
      { id: uid(), title: "Kafka sulla spiaggia", author: "Haruki Murakami", year: "2002", flags: ["letto", "preferito"], rating: 5, review: "Un romanzo che scorre come una corrente lenta. Ho letto le ultime pagine in una notte, con la luce spenta e la finestra aperta.", feeling: "Sognante", feelingTags: ["cullata", "straniata"], dateRead: "2026-02-08", reread: true },
      { id: uid(), title: "L'amica geniale", author: "Elena Ferrante", year: "2011", flags: ["prestato", "da_leggere"], lentTo: "Marta", returnDate: "2026-11-01" },
      { id: uid(), title: "La luna e i falò", author: "Cesare Pavese", year: "1950", flags: ["da_leggere"] },
      { id: uid(), title: "Il vecchio che leggeva romanzi d'amore", author: "Luis Sepúlveda", year: "1989", flags: ["letto"], rating: 4, review: "Nove giorni di lettura nella foresta, senza fretta. Mi ha lasciata una calma piena, come dopo la pioggia.", feeling: "Serena", feelingTags: ["tenera"], dateRead: "2025-12-30" },
    ];
  }

  // ---------- Open Library ----------
  const OL_FIELDS = "title,author_name,first_publish_year,cover_i,edition_count";
  const coverCache = new Map();
  const pending = new Set();
  const failedIds = new Set();

  const norm = (s) =>
    String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const coverImg = (id, size) => `https://covers.openlibrary.org/b/id/${id}-${size}.jpg?default=false`;
  const sized = (url, size) => String(url).replace(/-[SML]\.jpg/, `-${size}.jpg`);

  async function getJSON(url, ms = 8000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } finally { clearTimeout(t); }
  }

  function probe(url, ms = 8000) {
    return new Promise((resolve) => {
      const img = new Image();
      const t = setTimeout(() => resolve(false), ms);
      img.onload = () => { clearTimeout(t); resolve(img.naturalWidth > 2); };
      img.onerror = () => { clearTimeout(t); resolve(false); };
      img.src = url;
    });
  }

  function rank(c, title, author) {
    const t = norm(title), ct = norm(c.title);
    let ts = 0;
    if (ct && ct === t) ts = 5;
    else if (ct && (ct.startsWith(t) || t.startsWith(ct))) ts = 3;
    else if (ct && (ct.includes(t) || t.includes(ct))) ts = 2;
    let as = 0;
    const a = norm(author);
    if (a) {
      const last = a.split(" ").pop();
      if (c.authors.some((x) => norm(x).includes(last))) as = 3;
    }
    return { ...c, ts, score: ts + as + Math.min(c.editions, 50) / 50 };
  }

  // ---------- fonti per la ricerca da ISBN ----------
  // Indirizzo del proprio proxy (vedi worker.js), ad es. "https://isbn-proxy.tuonome.workers.dev".
  // Se impostato, SBN e Google Books passano da lì: niente blocchi CORS e niente limite di richieste.
  const ISBN_PROXY = "https://round-cloud-60d5.burba1996.workers.dev";
  const viaProxy = (url) => (ISBN_PROXY ? `${ISBN_PROXY.replace(/\/$/, "")}/?url=${encodeURIComponent(url)}` : url);

  // ---------- ricerca copertine (multi-fonte) ----------
  // Ogni candidato: { key, thumb, url, title, authors, year, editions, source }
  async function coversFromOpenLibrary(title, author) {
    const queries = [];
    if (author) queries.push({ title, author });
    queries.push({ q: `${title} ${author}`.trim() });
    if (author) queries.push({ title });
    const seen = new Map();
    let errors = 0;
    for (const qy of queries) {
      try {
        const params = new URLSearchParams({ ...qy, limit: "15", fields: OL_FIELDS });
        const data = await getJSON(`https://openlibrary.org/search.json?${params}`);
        for (const d of data.docs || []) {
          if (!d.cover_i || seen.has(d.cover_i)) continue;
          seen.set(d.cover_i, {
            key: "ol" + d.cover_i,
            thumb: coverImg(d.cover_i, "M"),
            url: coverImg(d.cover_i, "L"),
            title: d.title || "",
            authors: d.author_name || [],
            year: d.first_publish_year,
            editions: d.edition_count || 0,
            source: "Open Library",
          });
        }
      } catch { errors++; }
      if (seen.size >= 6) break;
    }
    if (errors === queries.length) throw new Error("Open Library non raggiungibile");
    return [...seen.values()];
  }

  // JSONP: aggira CORS (anche da file:// o origine "null") per API che lo supportano, come iTunes.
  function jsonp(url, ms = 8000) {
    return new Promise((resolve, reject) => {
      const cb = "__jsonp" + Math.random().toString(36).slice(2);
      const s = document.createElement("script");
      const t = setTimeout(() => done(new Error("timeout")), ms);
      function done(err, data) {
        clearTimeout(t);
        delete window[cb];
        s.remove();
        err ? reject(err) : resolve(data);
      }
      window[cb] = (d) => done(null, d);
      s.onerror = () => done(new Error("jsonp"));
      s.src = url + (url.includes("?") ? "&" : "?") + "callback=" + cb;
      document.head.appendChild(s);
    });
  }

  // Chiave API di Google Books (gratuita, console.cloud.google.com): evita il 429 della quota condivisa.
  // Restringila alle sole "Books API" e al tuo dominio.
  const GOOGLE_API_KEY = "";
  let googleCooldownUntil = 0; // dopo un 429 si salta Google Books per qualche minuto

  async function coversFromGoogleBooks(title, author) {
    if (Date.now() < googleCooldownUntil) throw new Error("429");
    const queries = [
      author ? `intitle:"${title}" inauthor:"${author}"` : `intitle:"${title}"`,
      `${title} ${author}`.trim(),
    ];
    for (const q of queries) {
      let api = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=20&printType=books&fields=items(id,volumeInfo(title,authors,publishedDate,imageLinks))`;
      if (GOOGLE_API_KEY) api += `&key=${GOOGLE_API_KEY}`;
      let data;
      try { data = await getJSON(viaProxy(api)); }
      catch (err) {
        if (String(err && err.message) === "429") googleCooldownUntil = Date.now() + 5 * 60 * 1000;
        throw err;
      }
      const out = (data.items || [])
        .filter((it) => it.volumeInfo && it.volumeInfo.imageLinks)
        .map((it) => {
          const v = it.volumeInfo;
          const img = `https://books.google.com/books/content?id=${it.id}&printsec=frontcover&img=1&zoom=1`;
          return {
            key: "gb" + it.id, thumb: img, url: img,
            title: v.title || "", authors: v.authors || [],
            year: ((v.publishedDate || "").match(/\d{4}/) || [])[0] || "",
            editions: 0, source: "Google Books",
          };
        });
      if (out.length) return out;
    }
    return [];
  }

  async function coversFromApple(title, author) {
    const params = new URLSearchParams({
      term: `${title} ${author}`.trim(), media: "ebook", entity: "ebook", country: "it", limit: "10",
    });
    const data = await jsonp(`https://itunes.apple.com/search?${params}`);
    return (data.results || [])
      .filter((r) => r.artworkUrl100)
      .map((r) => ({
        key: "ap" + r.trackId,
        thumb: r.artworkUrl100.replace("100x100bb", "300x300bb"),
        url: r.artworkUrl100.replace("100x100bb", "600x600bb"),
        title: r.trackName || "", authors: [r.artistName || ""],
        year: (r.releaseDate || "").slice(0, 4),
        editions: 0, source: "Apple Books",
      }));
  }

  // SBN: i record con ISBN includono "copertina" (link LibraryThing, in http e taglia "small").
  async function coversFromSbn(title, author) {
    const q = `${title} ${author}`.trim();
    const url = `https://opac.sbn.it/opacmobilegw/search.json?any=${encodeURIComponent(q)}`;
    const data = await getSbnJSON(url);
    const out = [], seen = new Set();
    for (const r of (data && data.briefRecords) || []) {
      const isbn = String(r.isbn || "").replace(/[^0-9X]/gi, "");
      if (!r.titolo || !r.copertina || !isbn || seen.has(isbn)) continue;
      seen.add(isbn);
      const base = String(r.copertina).replace(/^http:/, "https:");
      const years = String(r.pubblicazione || "").match(/\b(1[5-9]\d{2}|20\d{2})\b/g);
      out.push({
        key: "sbn" + isbn,
        thumb: base.replace("/small/", "/medium/"),
        url: base.replace("/small/", "/large/"),
        title: parseSbnTitle(r.titolo),
        authors: [parseSbnAuthor(r.autorePrincipale)],
        year: years ? years[years.length - 1] : "",
        editions: 0,
        source: "SBN",
      });
    }
    return out.slice(0, 10);
  }

  const COVER_SOURCES = [coversFromOpenLibrary, coversFromGoogleBooks, coversFromApple, coversFromSbn];

  function searchCovers(title, author) {
    const key = norm(title) + "|" + norm(author);
    if (coverCache.has(key)) return coverCache.get(key);
    const p = (async () => {
      const results = await Promise.allSettled(COVER_SOURCES.map((fn) => fn(title, author)));
      const seen = new Map();
      for (const r of results) {
        if (r.status !== "fulfilled") continue;
        for (const c of r.value) if (!seen.has(c.key)) seen.set(c.key, c);
      }
      const list = [...seen.values()].map((c) => rank(c, title, author)).sort((x, y) => y.score - x.score);
      return { list, failed: results.every((r) => r.status === "rejected") };
    })();
    coverCache.set(key, p);
    p.then((r) => { if (r.failed) coverCache.delete(key); });
    return p;
  }

  const SOURCE_LABELS = {
    fromSbn: "SBN",
    fromOpenLibrary: "Open Library",
    fromOpenLibraryEdition: "Open Library (edizione)",
    fromGoogleBooks: "Google Books",
  };
  function describeErr(err) {
    const msg = String(err && err.message);
    if (msg === "404") return "nessun risultato";
    if (msg === "429") return "limite di richieste raggiunto";
    if (err instanceof TypeError) return "bloccata dal browser o offline";
    if (err && err.name === "AbortError") return "troppo lenta";
    return "errore";
  }
  let lastLookupReport = "";

  // Catalogo SBN (Servizio Bibliotecario Nazionale): il database delle biblioteche italiane.
  // I titoli sono in formato ISBD ("Titolo : sottotitolo / responsabilità") e gli autori "Cognome, Nome".
  const isItalianIsbn = (isbn) => /^(97888|97912)/.test(isbn);

  function parseSbnTitle(raw) {
    return String(raw || "")
      .split(" / ")[0]            // toglie la menzione di responsabilità
      .replace(/<<|>>/g, "")      // articoli iniziali "<<La >>casa" -> "La casa"
      .replace(/\s+:\s+/g, ": ")  // " : sottotitolo" -> ": sottotitolo"
      .replace(/\s+/g, " ")
      .trim();
  }
  function parseSbnAuthor(raw) {
    const s = String(raw || "").replace(/<<|>>/g, "").trim();
    if (!s) return "";
    const i = s.indexOf(",");
    // "Orwell, George" -> "George Orwell"; elimina date tra parentesi tonde/angolari o in coda
    const clean = (x) => x.replace(/\(.*?\)|<.*?>/g, "").replace(/[,\s]*\d{3,4}.*$/, "").trim();
    return i === -1 ? clean(s) : `${clean(s.slice(i + 1))} ${clean(s.slice(0, i))}`.trim();
  }

  // Se il browser blocca SBN (CORS) si ripiega su proxy pubblici, che vedono solo l'ISBN cercato.
  const SBN_PROXIES = [
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  ];
  let sbnDirectBlocked = false;

  async function getSbnJSON(url) {
    if (ISBN_PROXY) return getJSON(viaProxy(url), 8000);
    if (!sbnDirectBlocked) {
      try { return await getJSON(url, 6000); }
      catch (err) {
        // un errore di rete/CORS arriva come TypeError: inutile riprovare in diretta
        if (err instanceof TypeError) sbnDirectBlocked = true;
        console.warn("SBN diretto non riuscito:", err);
      }
    }
    let lastErr;
    for (const wrap of SBN_PROXIES) {
      try { return await getJSON(wrap(url), 8000); }
      catch (err) { lastErr = err; console.warn("SBN via proxy non riuscito:", err); }
    }
    throw lastErr || new Error("SBN non raggiungibile");
  }

  async function fromSbn(isbn) {
    const data = await getSbnJSON(`https://opac.sbn.it/opacmobilegw/search.json?isbn=${isbn}`);
    const records = (data && data.briefRecords) || [];
    const digits = (x) => String(x || "").replace(/[^0-9X]/gi, "");
    const rec = records.find((r) => digits(r.isbn) === isbn && r.titolo) || records.find((r) => r.titolo);
    if (!rec) return null;
    const title = parseSbnTitle(rec.titolo);
    if (!title) return null;
    const years = String(rec.pubblicazione || "").match(/\b(1[5-9]\d{2}|20\d{2})\b/g);
    const coverUrl = rec.copertina ? String(rec.copertina).replace(/^http:/, "https:").replace("/small/", "/large/") : undefined;
    return { title, author: parseSbnAuthor(rec.autorePrincipale), year: years ? years[years.length - 1] : "", coverUrl };
  }

  async function fromOpenLibrary(isbn) {
    const data = await getJSON(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
    const bookData = data[`ISBN:${isbn}`];
    if (!bookData || !bookData.title) return null;
    const title = bookData.title || "";
    const author = bookData.authors ? bookData.authors.map((a) => a.name).join(", ") : "";
    const year = bookData.publish_date ? (bookData.publish_date.match(/\d{4}/) || [])[0] || "" : "";
    const coverUrl = bookData.cover ? bookData.cover.large || bookData.cover.medium : undefined;
    return { title, author, year, coverUrl };
  }

  // ISBN-13 (978...) -> ISBN-10: molti archivi hanno indicizzato solo la vecchia forma.
  function isbn13to10(isbn13) {
    if (!/^978\d{10}$/.test(isbn13)) return null;
    const body = isbn13.slice(3, 12);
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(body[i]) * (10 - i);
    const check = (11 - (sum % 11)) % 11;
    return body + (check === 10 ? "X" : String(check));
  }

  // Open Library, archivio per singola edizione: spesso ha libri che api/books non restituisce.
  async function fromOpenLibraryEdition(isbn) {
    const ed = await getJSON(`https://openlibrary.org/isbn/${isbn}.json`);
    if (!ed || !ed.title) return null;
    const title = ed.subtitle ? `${ed.title}: ${ed.subtitle}` : ed.title;
    const year = ((ed.publish_date || "").match(/\d{4}/) || [])[0] || "";
    const coverId = (ed.covers || []).find((c) => c > 0);
    const coverUrl = coverId ? coverImg(coverId, "L") : undefined;

    let keys = (ed.authors || []).map((a) => a.key).filter(Boolean);
    if (!keys.length && ed.works && ed.works[0] && ed.works[0].key) {
      try { // se l'edizione non ha autori, si guarda l'opera collegata
        const work = await getJSON(`https://openlibrary.org${ed.works[0].key}.json`, 5000);
        keys = (work.authors || []).map((a) => a.author && a.author.key).filter(Boolean);
      } catch {}
    }
    const names = await Promise.all(
      keys.slice(0, 3).map((k) => getJSON(`https://openlibrary.org${k}.json`, 5000).then((a) => a.name || "").catch(() => ""))
    );
    return { title, author: names.filter(Boolean).join(", "), year, coverUrl };
  }

  async function fromGoogleBooks(isbn) {
    // Più tentativi: il filtro isbn: a volte manca un'edizione che la ricerca libera trova;
    // le richieste che falliscono (es. limite di richieste) non fermano gli altri tentativi.
    const isbn10 = isbn13to10(isbn);
    const queries = [`isbn:${isbn}`, ...(isbn10 ? [`isbn:${isbn10}`] : []), isbn];
    let info = null, failures = 0, lastErr = null;
    for (const q of queries) {
      try {
        const data = await getJSON(viaProxy(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5`));
        const items = data.items || [];
        const hit = items.find((it) => {
          const ids = ((it.volumeInfo && it.volumeInfo.industryIdentifiers) || []).map((x) => x.identifier);
          return ids.includes(isbn) || (isbn10 && ids.includes(isbn10));
        }) || (q.startsWith("isbn:") ? items[0] : null);
        if (hit && hit.volumeInfo && hit.volumeInfo.title) { info = hit.volumeInfo; break; }
      } catch (err) { failures++; lastErr = err; }
    }
    if (!info) {
      if (failures === queries.length) throw lastErr; // tutte le richieste fallite: non è "nessun risultato"
      return null;
    }
    const title = info.subtitle ? `${info.title}: ${info.subtitle}` : info.title;
    const author = (info.authors || []).join(", ");
    const year = ((info.publishedDate || "").match(/\d{4}/) || [])[0] || "";
    const thumb = info.imageLinks && (info.imageLinks.thumbnail || info.imageLinks.smallThumbnail);
    const coverUrl = thumb ? String(thumb).replace(/^http:/, "https:").replace("&edge=curl", "") : undefined;
    return { title, author, year, coverUrl };
  }

  async function fetchByISBN(isbn) {
    const cleanIsbn = isbn.replace(/[^0-9X]/gi, "").toUpperCase();
    if (!cleanIsbn) return null;

    // Per gli ISBN italiani (978-88 / 979-12) si parte dal catalogo SBN; poi le fonti internazionali.
    const sources = isItalianIsbn(cleanIsbn)
      ? [fromSbn, fromOpenLibrary, fromOpenLibraryEdition, fromGoogleBooks]
      : [fromOpenLibrary, fromOpenLibraryEdition, fromGoogleBooks, fromSbn];

    let found = null;
    const report = [];
    for (const source of sources) {
      const label = SOURCE_LABELS[source.name] || source.name;
      try {
        const r = await source(cleanIsbn);
        if (!r) { report.push(`${label}: nessun risultato`); continue; }
        report.push(`${label}: trovato`);
        if (!found) found = r;
        else { // completa i campi mancanti con la fonte successiva
          for (const k of ["title", "author", "year", "coverUrl"]) if (!found[k] && r[k]) found[k] = r[k];
        }
        if (found.title && found.author && found.year) break;
      } catch (err) { // fonte non raggiungibile o bloccata (es. CORS): si passa alla successiva
        report.push(`${label}: ${describeErr(err)}`);
        console.warn(`Ricerca ISBN: ${label} non riuscita`, err);
      }
    }
    lastLookupReport = report.join(" · ");
    return found;
  }

  // ---------- scanner helpers ----------
  // EAN-13 valido con prefisso 978/979 (= ISBN-13). Scarta altri codici a barre.
  function isValidIsbn13(code) {
    if (!/^97[89]\d{10}$/.test(code)) return false;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 ? 3 : 1);
    return (10 - (sum % 10)) % 10 === Number(code[12]);
  }

  // Safari/Chrome iOS non hanno BarcodeDetector: carichiamo ZXing solo quando serve.
  const ZXING_URL = "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js";
  let zxingPromise = null;
  function loadZXing() {
    if (window.ZXing) return Promise.resolve(window.ZXing);
    if (!zxingPromise) {
      zxingPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = ZXING_URL;
        s.async = true;
        s.onload = () => (window.ZXing ? resolve(window.ZXing) : reject(new Error("ZXing mancante")));
        s.onerror = () => reject(new Error("Caricamento ZXing non riuscito"));
        document.head.appendChild(s);
      }).catch((err) => { zxingPromise = null; throw err; });
    }
    return zxingPromise;
  }

  // Restituisce una funzione async (sorgente video/immagine) => stringa ISBN | null
  async function createDecoder() {
    if ("BarcodeDetector" in window) {
      try {
        const bd = new BarcodeDetector({ formats: ["ean_13"] });
        return async (source) => {
          const codes = await bd.detect(source);
          const hit = codes.find((c) => isValidIsbn13(c.rawValue));
          return hit ? hit.rawValue : null;
        };
      } catch { /* formato non supportato: passiamo a ZXing */ }
    }
    const ZX = await loadZXing();
    const hints = new Map();
    hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [ZX.BarcodeFormat.EAN_13]);
    hints.set(ZX.DecodeHintType.TRY_HARDER, true);
    const reader = new ZX.MultiFormatReader();
    reader.setHints(hints);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    return async (source, full = false) => {
      const sw = source.videoWidth || source.naturalWidth || source.width;
      const sh = source.videoHeight || source.naturalHeight || source.height;
      if (!sw || !sh) return null;
      // video: ritaglia la fascia centrale (dove sta il riquadro guida);
      // foto: usa l'immagine intera. In entrambi i casi riduce la risoluzione.
      const cw = full ? sw : Math.round(sw * 0.8), ch = full ? sh : Math.round(sh * 0.5);
      const cx = Math.round((sw - cw) / 2), cy = Math.round((sh - ch) / 2);
      const scale = Math.min(1, (full ? 1600 : 900) / cw);
      canvas.width = Math.round(cw * scale);
      canvas.height = Math.round(ch * scale);
      ctx.drawImage(source, cx, cy, cw, ch, 0, 0, canvas.width, canvas.height);
      try {
        const lum = new ZX.HTMLCanvasElementLuminanceSource(canvas);
        const bitmap = new ZX.BinaryBitmap(new ZX.HybridBinarizer(lum));
        const text = reader.decode(bitmap).getText();
        return isValidIsbn13(text) ? text : null;
      } catch {
        return null; // nessun codice in questo frame
      }
    };
  }

  async function autoCover(title, author) {
    const { list, failed } = await searchCovers(title, author);
    for (const c of list.filter((x) => x.ts >= 2).slice(0, 3)) {
      if (await probe(c.thumb)) return { url: c.url, failed: false };
    }
    return { url: undefined, failed };
  }

  const queue = [];
  let active = 0;
  function enqueue(job) {
    queue.push(job);
    pump();
  }
  function pump() {
    while (active < 2 && queue.length) {
      const job = queue.shift();
      active++;
      job().finally(() => { active--; pump(); });
    }
  }
  function patchCover(b) {
    document.querySelectorAll(`[data-cover-id="${b.id}"]`).forEach((el) => {
      el.outerHTML = cover(b, el.classList.contains("lg") ? "lg" : "sm");
    });
  }
  function fillMissingCovers() {
    books.forEach((b) => {
      if (b.coverUrl || b.coverChecked || pending.has(b.id) || failedIds.has(b.id)) return;
      pending.add(b.id);
      enqueue(async () => {
        const { url, failed } = await autoCover(b.title, b.author);
        pending.delete(b.id);
        const x = books.find((y) => y.id === b.id);
        if (!x) return;
        if (failed) failedIds.add(b.id);
        else x.coverChecked = true;
        if (url) x.coverUrl = url;
        save();
        patchCover(x);
      });
    });
  }

  function commit() {
    save();
    render();
    fillMissingCovers();
  }
  function upsert(book) {
    const i = books.findIndex((b) => b.id === book.id);
    if (i === -1) books.push(book); else books[i] = book;
    commit();
  }

  // ---------- rendering ----------
  function cover(b, size) {
    const tone = b.flags.includes("prestato") ? "sky" : b.flags.includes("letto") ? "ink" : "sun";
    const searching = !b.coverUrl && pending.has(b.id) ? " searching" : "";
    const ph = `<div class="cover ${size} ph ph-${tone}${searching}" data-cover-id="${b.id}">${esc(b.title)}</div>`;
    if (!b.coverUrl) return ph;
    const src = sized(b.coverUrl, size === "lg" ? "L" : "M");
    return `<img class="cover ${size}" data-cover-id="${b.id}" src="${esc(src)}" alt="Copertina di ${esc(b.title)}" decoding="async" ${size === "lg" ? "" : 'loading="lazy"'} data-ph="${esc(ph)}">`;
  }
  const badges = (b) => b.flags.map((f) => `<span class="badge f-${f}">${FLAGS[f]}</span>`).join("");

  function renderHome() {
    const q = search.trim().toLowerCase();
    const visible = books.filter((b) => {
      for (const f of activeFilters) if (!b.flags.includes(f)) return false;
      return !q || b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q);
    });
    const lent = books.filter((b) => b.flags.includes("prestato")).length;
    const read = books.filter((b) => b.flags.includes("letto")).length;

    const cards = visible.length
      ? `<div class="grid">${visible
          .map((b, i) => {
            const meta = [
              b.flags.includes("prestato") ? `→ ${esc(b.lentTo || "?")}${b.returnDate ? ` · restit. ${shortDate(b.returnDate)}` : ""}` : null,
              b.rating ? `${b.rating} ★` : null,
              b.dateRead ? shortDate(b.dateRead) : null,
            ].filter(Boolean);
            return `<a class="card" href="#/libro/${b.id}" style="animation-delay:${200 + i * 60}ms">
              <div class="card-top">${cover(b, "sm")}<div class="badges">${badges(b)}</div></div>
              <h3>${esc(b.title)}</h3>
              <p class="sub">${esc(b.author)}${b.year ? ` · ${esc(b.year)}` : ""}</p>
              ${b.feeling ? `<p class="quote">"Mi ha fatta sentire ${esc(b.feeling.toLowerCase())}"</p>` : ""}
              ${meta.length ? `<p class="mono">${meta.join(" · ")}</p>` : ""}
            </a>`;
          })
          .join("")}</div>`
      : `<div class="empty"><p class="display" style="font-size:24px">Nessun libro qui</p>
          <p class="sub" style="margin-top:8px">${search ? "Prova con un altro titolo o autore." : "Aggiungi il primo libro alla tua libreria."}</p>
          <button class="btn btn-primary" data-action="new" style="margin-top:20px">+ Aggiungi libro</button></div>`;

    $("#app").innerHTML = `
      <section class="wrap hero">
        <p class="mono" style="letter-spacing:.2em">${books.length} libri · ${lent} prestati · ${read} letti</p>
        <h1>La mia <em>libreria</em> di casa</h1>
        <p class="lead">Ogni volume, un ricordo. Segna se l'hai letto, chi l'ha preso in prestito, e come ti ha fatto sentire.</p>
        <div class="searchrow">
          <div class="search">⌕ <input id="search" placeholder="Cerca per titolo o autore…" value="${esc(search)}"></div>
        </div>
        <div class="filterrow">
          <nav class="filters" aria-label="Filtri">${Object.entries(FILTERS)
            .map(([k, v]) => `<button type="button" data-filter="${k}" class="${activeFilters.has(k) ? "on" : ""}" aria-pressed="${activeFilters.has(k)}">${v}</button>`)
            .join("")}</nav>
          <button class="btn btn-ink" data-action="new">+ Aggiungi</button>
        </div>
      </section>
      <section class="wrap">${cards}</section>`;
  }

  function renderDetail(id) {
    const b = books.find((x) => x.id === id);
    if (!b) {
      $("#app").innerHTML = `<section class="wrap detail" style="text-align:center"><p class="display" style="font-size:32px">Libro non trovato</p>
        <a class="btn btn-primary" href="#/" style="display:inline-block;margin-top:16px">← Torna alla libreria</a></section>`;
      return;
    }
    const lent = b.flags.includes("prestato");
    const tags = (b.feelingTags || []).map((t) => `<span>${esc(t)}</span>`).join("");
    $("#app").innerHTML = `
      <section class="wrap detail">
        <a class="back" href="#/">← La mia libreria</a>
        <div class="detail-top">
          ${cover(b, "lg")}
          <div>
            <div class="tags" style="margin-top:0">${badges(b)}</div>
            <h1>${esc(b.title)}</h1>
            <p class="author">${esc(b.author)}${b.year ? ` · ${esc(b.year)}` : ""}</p>
            ${b.rating ? `<p class="stars">${"★".repeat(b.rating)}<span>${"★".repeat(5 - b.rating)}</span></p>` : ""}
            <div class="facts">
              ${lent ? `<div class="fact lent"><span class="mono">Prestato a</span><strong>${esc(b.lentTo)}</strong>${b.returnDate ? `<span class="mono">Restituzione: ${longDate(b.returnDate)}</span>` : ""}</div>` : ""}
              ${b.dateRead ? `<div class="fact"><span class="mono">Finito il</span><strong>${longDate(b.dateRead)}</strong>${b.reread ? `<span class="mono">Riletto</span>` : ""}</div>` : ""}
            </div>
          </div>
        </div>
        <div class="review">
          <p class="kicker">La mia recensione</p>
          <p class="text">${b.review ? esc(b.review) : "Nessuna recensione ancora. Premi “Modifica” per scriverla."}</p>
          <div class="feel">
            <p class="kicker">Come mi ha fatta sentire</p>
            <p class="word">${esc(b.feeling) || "—"}</p>
            ${tags ? `<div class="tags">${tags}</div>` : ""}
          </div>
        </div>
        <div class="actions">
          <button class="btn btn-primary" data-action="edit" data-id="${b.id}">Modifica</button>
          ${lent ? `<button class="btn btn-ghost" data-action="returned" data-id="${b.id}">Segna restituito</button>` : ""}
          <button class="btn btn-ghost" data-action="delete" data-id="${b.id}">Elimina</button>
        </div>
      </section>`;
  }

  function render() {
    const act = document.activeElement;
    const keep = act && act.id === "search" ? act.selectionStart : null;
    const m = location.hash.match(/^#\/libro\/(.+)$/);
    if (m) renderDetail(decodeURIComponent(m[1]));
    else renderHome();
    if (keep !== null) {
      const el = $("#search");
      if (el) { el.focus(); el.setSelectionRange(keep, keep); }
    }
  }

  document.addEventListener("error", (e) => {
    const img = e.target;
    if (img.tagName === "IMG" && img.classList.contains("cover") && img.dataset.ph) img.outerHTML = img.dataset.ph;
  }, true);
  document.addEventListener("load", (e) => {
    const img = e.target;
    if (img.tagName !== "IMG" || !img.classList.contains("cover")) return;
    if (img.naturalWidth <= 2 && img.dataset.ph) img.outerHTML = img.dataset.ph;
    else img.classList.add("ready");
  }, true);

  // ---------- form e scanner ----------
  function openForm(book) {
    const f = {
      flags: ["da_leggere"], coverUrl: "", title: "", author: "", year: "", isbn: "", lentTo: "", returnDate: "",
      rating: 0, review: "", feeling: "", feelingTags: [], dateRead: "", reread: false,
      ...(book ? JSON.parse(JSON.stringify(book)) : {}),
    };
    const modal = $("#modal");

    let cs = { state: "idle", list: [], msg: "" };
    let searchSeq = 0;
    let isScanning = false;
    let mediaStream = null;
    let scanInterval = null;
    let scanSeq = 0;
    let isbnMsg = "";

    function setStatus(msg) {
      isbnMsg = msg;
      const el = $("#isbnStatus", modal);
      if (el) el.textContent = msg;
    }

    function coverBoxHTML() {
      const loading = cs.state === "loading";
      const preview = f.coverUrl ? `<img class="preview" src="${esc(sized(f.coverUrl, "M"))}" alt="Copertina scelta">` : `<div class="preview"></div>`;
      let picker = "";
      if (loading) {
        picker = `<div class="picker">${'<div class="pick sk"></div>'.repeat(6)}</div><p class="small">Cerco su Open Library, Google Books e Apple Books…</p>`;
      } else if (cs.state === "done") {
        picker = `<p class="small">Tocca la copertina giusta</p><div class="picker">${cs.list.map((c, i) => {
          const sel = f.coverUrl && sized(f.coverUrl, "L") === sized(c.url, "L");
          const titleAttr = esc([c.title, c.year, c.source].filter(Boolean).join(" · "));
          const bestBadge = i === 0 && c.ts >= 2 ? '<span class="best">Consigliata</span>' : '';
          return `<button type="button" class="pick${sel ? ' sel' : ''}" data-pick="${i}" title="${titleAttr}">
            <img src="${esc(c.thumb)}" alt="${esc(c.title)}" loading="lazy" onerror="this.closest('.pick').remove()">
            ${bestBadge}</button>`;
        }).join('')}</div>`;
      } else if (cs.msg) {
        picker = `<p class="small">${esc(cs.msg)}</p>`;
      }
      return `<div class="coverrow">${preview}
        <div style="display:grid;gap:8px;justify-items:start">
          <button type="button" class="btn btn-sky" data-cover ${loading ? "disabled" : ""}>${loading ? "Cerco…" : cs.state === "idle" ? "Cerca copertina" : "Cerca di nuovo"}</button>
          ${f.coverUrl ? `<button type="button" class="small" data-nocover style="text-decoration:underline">Rimuovi copertina</button>` : ""}
        </div></div>${picker}`;
    }

    function renderCoverBox() {
      const box = $("#coverBox", modal);
      if (box) box.innerHTML = coverBoxHTML();
    }

    async function runCoverSearch() {
      sync();
      const title = f.title.trim(), author = f.author.trim();
      if (!title) { cs = { state: "none", list: [], msg: "Scrivi prima il titolo." }; return renderCoverBox(); }
      const seq = ++searchSeq;
      cs = { state: "loading", list: [], msg: "" };
      renderCoverBox();
      const { list, failed } = await searchCovers(title, author);
      if (seq !== searchSeq || modal.hidden) return;
      cs = list.length
        ? { state: "done", list: list.slice(0, 9), msg: "" }
        : { state: "none", list: [], msg: failed ? "Connessione alle fonti di copertine non riuscita. Riprova." : "Nessuna copertina trovata. Controlla titolo e autore." };
      renderCoverBox();
    }

    async function processISBN(isbnValue) {
      sync();
      setStatus("Ricerca libro in corso…");
      const result = await fetchByISBN(isbnValue);
      if (modal.hidden) return;
      if (result) {
        if (result.title) f.title = result.title;
        if (result.author) f.author = result.author;
        if (result.year) f.year = result.year;
        if (result.coverUrl) f.coverUrl = result.coverUrl;
        isbnMsg = "Libro trovato: controlla i dati e salva.";
        draw();
      } else {
        setStatus(`Libro non trovato. ${lastLookupReport} — compila i dati a mano.`);
      }
    }

    function stopScanner() {
      scanSeq++; // annulla eventuali avvii ancora in corso
      if (scanInterval) { clearInterval(scanInterval); scanInterval = null; }
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
        mediaStream = null;
      }
      isScanning = false;
    }

    function gotIsbn(isbn) {
      stopScanner();
      f.isbn = isbn;
      isbnMsg = "";
      draw();
      processISBN(isbn);
    }

    async function startScanner() {
      // Senza getUserMedia (pagina non HTTPS o browser molto vecchio) si passa alla foto.
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const input = $("#isbnPhoto", modal);
        setStatus(window.isSecureContext
          ? "Fotocamera live non disponibile: scatta una foto del codice."
          : "La fotocamera live richiede HTTPS: scatta una foto del codice.");
        if (input) input.click();
        return;
      }
      sync();
      stopScanner();
      const seq = scanSeq;
      isScanning = true;
      isbnMsg = "Avvio fotocamera…";
      draw();

      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (seq !== scanSeq) { stream.getTracks().forEach((t) => t.stop()); return; }
        mediaStream = stream;

        const video = $("#scannerVideo", modal);
        video.muted = true; // iOS Safari richiede muted + playsinline per l'avvio automatico
        video.setAttribute("playsinline", "");
        video.srcObject = stream;
        await video.play();

        // messa a fuoco continua dove disponibile (Chrome Android)
        try {
          const track = stream.getVideoTracks()[0];
          const caps = track.getCapabilities ? track.getCapabilities() : {};
          if (caps.focusMode && caps.focusMode.includes("continuous")) {
            await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
          }
        } catch {}

        setStatus("Preparo il lettore…");
        const decode = await createDecoder();
        if (seq !== scanSeq) return;
        setStatus("Inquadra il codice a barre sul retro del libro.");

        let busy = false;
        scanInterval = setInterval(async () => {
          if (busy || seq !== scanSeq) return;
          busy = true;
          try {
            const isbn = await decode(video);
            if (isbn && seq === scanSeq) gotIsbn(isbn);
          } catch {} finally { busy = false; }
        }, 300);
      } catch (err) {
        if (seq !== scanSeq) { if (stream) stream.getTracks().forEach((t) => t.stop()); return; }
        const name = err && err.name;
        stopScanner();
        isbnMsg =
          name === "NotAllowedError" || name === "SecurityError"
            ? "Permesso negato: consenti l'accesso alla fotocamera nelle impostazioni del browser."
            : name === "NotFoundError" || name === "OverconstrainedError"
            ? "Nessuna fotocamera disponibile su questo dispositivo."
            : "Impossibile avviare la scansione. Scatta una foto del codice o scrivi l'ISBN.";
        draw();
      }
    }

    async function scanFromPhoto(file) {
      sync();
      setStatus("Leggo il codice dalla foto…");
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const decode = await createDecoder();
        const isbn = await decode(img, true);
        if (isbn) gotIsbn(isbn);
        else setStatus("Codice non leggibile: avvicinati, tieni il codice ben a fuoco e riprova.");
      } catch {
        setStatus("Lettura non riuscita. Riprova oppure scrivi l'ISBN.");
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    function draw() {
      modal.innerHTML = `
        <div class="sheet">
          <div class="sheet-head"><h2>${book ? "Modifica libro" : "Nuovo libro"}</h2><button class="btn" data-close>✕</button></div>
          <form class="form" id="bookForm">
            <div class="isbn-box">
              <span style="font-size:14px;font-weight:700">Autocompila da ISBN</span>
              ${isScanning ? `
                <div class="scanner-container">
                  <video id="scannerVideo" playsinline muted autoplay></video>
                  <div class="scanner-guide"></div>
                </div>
                <button type="button" class="btn btn-ghost" data-stop-scan>Annulla scansione</button>
              ` : `
                <div class="isbn-row">
                  <input class="field" name="isbn" value="${esc(f.isbn)}" placeholder="Codice ISBN (es. 978...)" inputmode="numeric" autocomplete="off">
                  <button type="button" class="btn btn-sky" data-fetch-isbn>Cerca</button>
                  <button type="button" class="btn btn-sun" data-start-scan title="Scansiona con fotocamera">📷 Scansiona</button>
                </div>
                <button type="button" class="small linklike" data-photo>Oppure scatta una foto del codice a barre</button>
                <input type="file" id="isbnPhoto" accept="image/*" capture="environment" hidden>
              `}
              <span id="isbnStatus" class="small" role="status" aria-live="polite">${esc(isbnMsg)}</span>
            </div>

            <div class="row">
              <label>Titolo *<input class="field" name="title" required value="${esc(f.title)}" placeholder="Kafka sulla spiaggia"></label>
              <label>Anno<input class="field" name="year" value="${esc(f.year)}" placeholder="2002"></label>
            </div>
            <label>Autore *<input class="field" name="author" required value="${esc(f.author)}" placeholder="Haruki Murakami"></label>
            <div id="coverBox">${coverBoxHTML()}</div>
            <div><span style="font-size:14px">Etichette (puoi sceglierne più di una)</span>
              <div class="flagpick">${Object.entries(FLAGS)
                .map(([k, v]) => { const on = f.flags.includes(k); return `<button type="button" data-flag="${k}" aria-pressed="${on}" class="${on ? "f-" + k : ""}">${on ? "✓ " : ""}${v}</button>`; })
                .join("")}</div>
            </div>
            ${f.flags.includes("prestato") ? `<div class="row half">
              <label>Prestato a<input class="field" name="lentTo" value="${esc(f.lentTo)}" placeholder="Marco"></label>
              <label>Restituzione<input class="field" type="date" name="returnDate" value="${esc(f.returnDate)}"></label></div>` : ""}
            ${f.flags.includes("letto") ? `<div class="row half">
              <div><span style="font-size:14px">Voto</span><div class="starpick">${[1, 2, 3, 4, 5]
                .map((n) => `<button type="button" data-star="${n}" class="${f.rating >= n ? "on" : ""}" aria-label="${n} stelle">★</button>`).join("")}</div></div>
              <label>Finito il<input class="field" type="date" name="dateRead" value="${esc(f.dateRead)}"></label></div>
              <label class="check"><input type="checkbox" name="reread" ${f.reread ? "checked" : ""}> Riletto</label>` : ""}
            <label>Recensione personale<textarea class="field" name="review" rows="4" placeholder="Cosa ti ha lasciato questo libro?">${esc(f.review)}</textarea></label>
            <div class="row half">
              <label>Come mi ha fatta sentire<input class="field" name="feeling" value="${esc(f.feeling)}" placeholder="Nostalgica"></label>
              <label>Altre sensazioni (virgole)<input class="field" name="feelingTags" value="${esc((f.feelingTags || []).join(", "))}" placeholder="tenera, inquieta"></label>
            </div>
            <div class="formfoot">
              <button type="button" class="btn btn-ghost" data-close>Annulla</button>
              <button type="submit" class="btn btn-primary">${book ? "Salva modifiche" : "Aggiungi alla libreria"}</button>
            </div>
          </form>
        </div>`;
    }

    function sync() {
      const form = $("#bookForm", modal);
      if (!form) return;
      const d = new FormData(form);
      ["title", "author", "year", "isbn", "lentTo", "returnDate", "dateRead", "review", "feeling"].forEach((k) => {
        if (d.has(k)) f[k] = String(d.get(k));
      });
      if (d.has("feelingTags")) f.feelingTags = String(d.get("feelingTags")).split(",").map((t) => t.trim()).filter(Boolean);
      if (form.reread) f.reread = form.reread.checked;
    }

    modal.onclick = async (e) => {
      const t = e.target.closest("button") || e.target;
      if (e.target === modal || t.hasAttribute?.("data-close")) return close();
      if (t.dataset?.flag) {
        sync();
        const k = t.dataset.flag;
        f.flags = f.flags.includes(k) ? f.flags.filter((x) => x !== k) : [...f.flags, k];
        draw();
      } else if (t.dataset?.star) {
        sync(); f.rating = Number(t.dataset.star); draw();
      } else if (t.dataset?.pick) {
        sync();
        const c = cs.list[Number(t.dataset.pick)];
        if (c) f.coverUrl = c.url;
        renderCoverBox();
      } else if (t.hasAttribute?.("data-nocover")) {
        sync(); f.coverUrl = ""; renderCoverBox();
      } else if (t.hasAttribute?.("data-cover")) {
        runCoverSearch();
      } else if (t.hasAttribute?.("data-start-scan")) {
        startScanner();
      } else if (t.hasAttribute?.("data-photo")) {
        const input = $("#isbnPhoto", modal);
        if (input) input.click();
      } else if (t.hasAttribute?.("data-stop-scan")) {
        stopScanner();
        isbnMsg = "";
        draw();
      } else if (t.hasAttribute?.("data-fetch-isbn")) {
        sync();
        if (f.isbn) processISBN(f.isbn);
      }
    };

    modal.onchange = (e) => {
      if (e.target.id !== "isbnPhoto") return;
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (file) scanFromPhoto(file);
    };

    modal.onfocusout = (e) => {
      if (!["title", "author"].includes(e.target.name) || f.coverUrl || cs.state !== "idle") return;
      sync();
      if (f.title.trim() && f.author.trim()) runCoverSearch();
    };

    modal.onsubmit = (e) => {
      e.preventDefault();
      sync();
      if (!f.title.trim() || !f.author.trim()) return;
      const lent = f.flags.includes("prestato");
      const changed = !book || book.title !== f.title.trim() || book.author !== f.author.trim();
      const out = {
        id: f.id || uid(),
        title: f.title.trim(),
        author: f.author.trim(),
        year: f.year.trim() || undefined,
        isbn: f.isbn.trim() || undefined,
        flags: f.flags,
        coverUrl: f.coverUrl || undefined,
        coverChecked: f.coverUrl ? true : changed ? false : book?.coverChecked,
        lentTo: lent ? f.lentTo.trim() || "qualcuno" : undefined,
        returnDate: lent && f.returnDate ? f.returnDate : undefined,
        rating: f.rating > 0 ? f.rating : undefined,
        review: f.review.trim() || undefined,
        feeling: f.feeling.trim() || undefined,
        feelingTags: f.feelingTags,
        dateRead: f.dateRead || undefined,
        reread: f.reread,
      };
      close();
      upsert(out);
    };

    function close() {
      stopScanner();
      searchSeq++;
      modal.hidden = true;
      modal.innerHTML = "";
    }

    draw();
    modal.hidden = false;
  }

  // ---------- events ----------
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-filter],[data-action]");
    if (!t || t.closest("#modal")) return;
    if (t.dataset.filter) {
      const k = t.dataset.filter;
      if (activeFilters.has(k)) activeFilters.delete(k); else activeFilters.add(k);
      render();
      return;
    }
    const b = books.find((x) => x.id === t.dataset.id);
    switch (t.dataset.action) {
      case "new": openForm(); break;
      case "edit": openForm(b); break;
      case "returned":
        upsert({ ...b, flags: b.flags.filter((f) => f !== "prestato"), lentTo: undefined, returnDate: undefined });
        break;
      case "delete":
        if (confirm(`Rimuovere "${b.title}" dalla libreria?`)) {
          books = books.filter((x) => x.id !== b.id);
          location.hash = "#/";
          commit();
        }
        break;
    }
  });
  document.addEventListener("input", (e) => {
    if (e.target.id !== "search") return;
    search = e.target.value;
    render();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#modal").hidden) {
      const closeBtn = $("#modal [data-close]");
      if (closeBtn) closeBtn.click();
    }
  });
  window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });

  books = load() || seed();
  commit();
})();
