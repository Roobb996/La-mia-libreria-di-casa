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
  const activeFilters = new Set(); // filtri attivi (toggle on/off, combinabili)
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
  const pending = new Set();   // libri in coda o in ricerca
  const failedIds = new Set(); // errori di rete in questa sessione (si riprova al prossimo avvio)

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
  // verifica che l'immagine esista davvero (niente placeholder 1x1)
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

  // Restituisce { list, failed }: candidati con copertina, ordinati per pertinenza
  function searchCovers(title, author) {
    const key = norm(title) + "|" + norm(author);
    if (coverCache.has(key)) return coverCache.get(key);
    const p = (async () => {
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
            seen.set(d.cover_i, { id: d.cover_i, title: d.title || "", authors: d.author_name || [], year: d.first_publish_year, editions: d.edition_count || 0 });
          }
        } catch { errors++; }
        if (seen.size >= 6) break;
      }
      const list = [...seen.values()].map((c) => rank(c, title, author)).sort((x, y) => y.score - x.score);
      return { list, failed: errors === queries.length };
    })();
    coverCache.set(key, p);
    p.then((r) => { if (r.failed) coverCache.delete(key); });
    return p;
  }

  // Scelta automatica: primo candidato pertinente la cui immagine si carica davvero
  async function autoCover(title, author) {
    const { list, failed } = await searchCovers(title, author);
    for (const c of list.filter((x) => x.ts >= 2).slice(0, 3)) {
      if (await probe(coverImg(c.id, "M"))) return { url: coverImg(c.id, "L"), failed: false };
    }
    return { url: undefined, failed };
  }

  // coda con 2 richieste in parallelo
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

  // immagini copertina: fade-in, fallback se mancanti o placeholder 1x1
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

  // ---------- form ----------
  function openForm(book) {
    const f = {
      flags: ["da_leggere"], coverUrl: "", title: "", author: "", year: "", lentTo: "", returnDate: "",
      rating: 0, review: "", feeling: "", feelingTags: [], dateRead: "", reread: false,
      ...(book ? JSON.parse(JSON.stringify(book)) : {}),
    };
    const modal = $("#modal");

    // stato ricerca copertine nel form
    let cs = { state: "idle", list: [], msg: "" };
    let searchSeq = 0;

    function coverBoxHTML() {
      const loading = cs.state === "loading";
      const preview = f.coverUrl ? `<img class="preview" src="${esc(sized(f.coverUrl, "M"))}" alt="Copertina scelta">` : `<div class="preview"></div>`;
      let picker = "";
      if (loading) {
        picker = `<div class="picker">${'<div class="pick sk"></div>'.repeat(6)}</div><p class="small">Cerco su Open Library…</p>`;
      } else if (cs.state === "done") {
        picker = `<p class="small">Tocca la copertina giusta</p><div class="picker">${cs.list.map((c, i) => {
          const sel = f.coverUrl && String(f.coverUrl).includes(`/${c.id}-`);
          return `<button type="button" class="pick${sel ? " sel" : ""}" data-pick="${c.id}" title="${esc(c.title)}${c.year ? " · " + c.year : ""}">
            <img src="${coverImg(c.id, "M")}" alt="${esc(c.title)}" loading="lazy" onerror="this.closest('.pick').remove()">
            ${i === 0 && c.ts >= 2 ? '<span class="best">Consigliata</span>' : ""}</button>`;
        }).join("")}</div>`;
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
        : { state: "none", list: [], msg: failed ? "Connessione a Open Library non riuscita. Riprova." : "Nessuna copertina trovata. Controlla titolo e autore." };
      renderCoverBox();
    }

    function draw() {
      modal.innerHTML = `
        <div class="sheet">
          <div class="sheet-head"><h2>${book ? "Modifica libro" : "Nuovo libro"}</h2><button class="btn" data-close>✕</button></div>
          <form class="form" id="bookForm">
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

    // keep typed values when redrawing
    function sync() {
      const form = $("#bookForm", modal);
      if (!form) return;
      const d = new FormData(form);
      ["title", "author", "year", "lentTo", "returnDate", "dateRead", "review", "feeling"].forEach((k) => {
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
        sync(); f.coverUrl = coverImg(t.dataset.pick, "L"); renderCoverBox();
      } else if (t.hasAttribute?.("data-nocover")) {
        sync(); f.coverUrl = ""; renderCoverBox();
      } else if (t.hasAttribute?.("data-cover")) {
        runCoverSearch();
      }
    };
    // ricerca automatica quando titolo e autore sono compilati
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
    function close() { searchSeq++; modal.hidden = true; modal.innerHTML = ""; }

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
    if (e.key === "Escape" && !$("#modal").hidden) { $("#modal").hidden = true; $("#modal").innerHTML = ""; }
  });
  window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });

  books = load() || seed();
  commit();
})();
