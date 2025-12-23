const output = document.getElementById("output");
const statusEl = document.getElementById("status");

const searchInput = document.getElementById("searchInput");
const suggestionsEl = document.getElementById("suggestions");
const chipsEl = document.getElementById("chips");
const clearBtn = document.getElementById("clear");

// Modal elements
const modalOverlay = document.getElementById("modalOverlay");
const modalClose = document.getElementById("modalClose");
const modalTitle = document.getElementById("modalTitle");
const modalSubtitle = document.getElementById("modalSubtitle");
const modalBody = document.getElementById("modalBody");

// --- state ---
let genresCache = []; // [{id,name}]
let selected = []; // tokens: {type:'person'|'genre'|'keyword', id:string, name:string}
let timer = null;
let searchSeq = 0;

const IMG_BASE = "https://image.tmdb.org/t/p/w342";

function setStatus(msg) {
  statusEl.textContent = msg || "";
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, function (s) {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[s];
  });
}

function tokenKey(t) {
  return t.type + ":" + t.id;
}

function showSuggestions(show) {
  suggestionsEl.style.display = show ? "block" : "none";
  if (!show) suggestionsEl.innerHTML = "";
}

function addToken(type, id, name) {
  const t = { type, id: String(id), name: String(name) };
  const exists = selected.some(x => tokenKey(x) === tokenKey(t));
  if (!exists) {
    selected.push(t);
    renderChips();
    runSearch();
  }
}

function removeToken(key) {
  selected = selected.filter(t => tokenKey(t) !== key);
  renderChips();
  runSearch();
}

async function api(path, params) {
  const qs = new URLSearchParams(Object.assign({ path: path }, params || {}));
  const res = await fetch("/.netlify/functions/api?" + qs.toString());
  const text = await res.text();

  if (text.trim().startsWith("<")) {
    throw new Error("Function returned HTML (wrong server/route). Use http://localhost:8888 with netlify dev.");
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("JSON parse failed. First chars: " + text.slice(0, 80));
  }

  if (!res.ok) {
    throw new Error((data && (data.status_message || data.error)) || ("HTTP " + res.status));
  }

  return data;
}

function renderChips() {
  chipsEl.innerHTML = selected.map(t => `
    <span class="chip" data-key="${tokenKey(t)}">
      ${escapeHtml(t.name)}
      <span class="chipType">${escapeHtml(t.type)}</span>
      <button type="button" aria-label="Remove">×</button>
    </span>
  `).join("");
}

chipsEl.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  if (e.target.tagName === "BUTTON") {
    removeToken(chip.getAttribute("data-key"));
  }
});

function renderSuggestions(items) {
  if (!items.length) {
    showSuggestions(false);
    return;
  }

  suggestionsEl.innerHTML = items.map(i => `
    <div class="resultItem" data-type="${i.type}" data-id="${i.id}" data-name="${escapeHtml(i.name)}">
      <span>${escapeHtml(i.name)}</span>
      <span class="suggestionType">${escapeHtml(i.type)}</span>
    </div>
  `).join("");

  showSuggestions(true);
}

suggestionsEl.addEventListener("click", (e) => {
  const item = e.target.closest(".resultItem");
  if (!item) return;

  const type = item.getAttribute("data-type");
  const id = item.getAttribute("data-id");
  const name = item.getAttribute("data-name");

  addToken(type, id, name);

  searchInput.value = "";
  showSuggestions(false);
  searchInput.focus();
});

// close suggestions when clicking elsewhere
document.addEventListener("click", (e) => {
  const inSearch = e.target.closest(".searchBox") || e.target.closest("#suggestions");
  if (!inSearch) showSuggestions(false);
});

async function loadGenres() {
  const data = await api("genre/movie/list", { language: "en-US" });
  genresCache = data.genres || [];
}

function currentFragment(raw) {
  return raw.split(",").pop().trim();
}

async function getSuggestions(raw) {
  const fragment = currentFragment(raw);
  if (fragment.length < 2) return [];

  const fLower = fragment.toLowerCase();

  const genreMatches = genresCache
    .filter(g => g.name.toLowerCase().includes(fLower))
    .slice(0, 6)
    .map(g => ({ type: "genre", id: String(g.id), name: g.name }));

  const [people, keywords, movies] = await Promise.all([
    api("search/person", { query: fragment, include_adult: "false", language: "en-US", page: "1" }),
    api("search/keyword", { query: fragment, page: "1" }),
    api("search/movie", { query: fragment, include_adult: "false", language: "en-US", page: "1" })
  ]);

  const personMatches = (people.results || []).slice(0, 6).map(p => ({ type: "person", id: String(p.id), name: p.name }));
  const keywordMatches = (keywords.results || []).slice(0, 6).map(k => ({ type: "keyword", id: String(k.id), name: k.name }));
  const movieMatches = (movies.results || []).slice(0, 6).map(m => ({ type: "movie", id: String(m.id), name: m.title }));

  const selectedKeys = new Set(selected.map(tokenKey));
  const combined = [...personMatches, ...genreMatches, ...keywordMatches, ...movieMatches]
    .filter(x => !selectedKeys.has(tokenKey(x)));

  // De-dupe: same type + same (normalized) name => only show one
  const seen = new Set();
  const deduped = [];
  for (const item of combined) {
    const normName = String(item.name).trim().toLowerCase().replace(/\s+/g, " ");
    const k = `${item.type}::${normName}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(item);
  }

  return deduped;
}

searchInput.addEventListener("input", () => {
  clearTimeout(timer);
  const raw = searchInput.value;

  timer = setTimeout(() => {
    getSuggestions(raw)
      .then(renderSuggestions)
      .catch((e) => {
        setStatus(e?.message || String(e));
        showSuggestions(false);
      });
  }, 250);
});

// Enter triggers search (optional); Backspace removes last chip when empty (nice UX)
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runSearch();
  }
  if (e.key === "Backspace" && !searchInput.value && selected.length) {
    selected.pop();
    renderChips();
    runSearch();
  }
});

function renderGrid(movies) {
  if (!movies?.length) {
    output.textContent = "No results.";
    return;
  }

  output.innerHTML = `
    <div class="grid">
      ${movies.slice(0, 20).map(m => `
        <div class="card" data-movie-id="${m.id}">
          ${m.poster_path
            ? `<img src="${IMG_BASE}${m.poster_path}" alt="${escapeHtml(m.title)}" />`
            : `<div class="noposter">No poster</div>`
          }
          <div class="movieTitle">${escapeHtml(m.title)}</div>
          <div class="meta">${escapeHtml(m.release_date || "")}</div>
        </div>
      `).join("")}
    </div>
  `;
}

// Click movie card -> open modal
output.addEventListener("click", (e) => {
  const card = e.target.closest(".card[data-movie-id]");
  if (!card) return;
  const movieId = card.getAttribute("data-movie-id");
  openMovieModal(movieId);
});

function openModal() {
  modalOverlay.classList.add("open");
  modalOverlay.setAttribute("aria-hidden", "false");
}

function closeModal() {
  modalOverlay.classList.remove("open");
  modalOverlay.setAttribute("aria-hidden", "true");
  modalBody.innerHTML = "";
}

modalClose.addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modalOverlay.classList.contains("open")) closeModal();
});

// Modal: clicking pills adds tokens
modalBody.addEventListener("click", (e) => {
  const pill = e.target.closest(".pill");
  if (!pill) return;
  const type = pill.getAttribute("data-type");
  const id = pill.getAttribute("data-id");
  const name = pill.getAttribute("data-name");
  addToken(type, id, name);
});

function pill(type, id, name) {
  return `<span class="pill" data-type="${type}" data-id="${String(id)}" data-name="${escapeHtml(String(name))}">${escapeHtml(String(name))}</span>`;
}

async function openMovieModal(movieId) {
  openModal();
  modalTitle.textContent = "Loading…";
  modalSubtitle.textContent = "";
  modalBody.innerHTML = "";

  try {
    // Get details + credits + keywords in parallel
    const [details, credits, keywordData] = await Promise.all([
      api(`movie/${movieId}`, { language: "en-US" }),
      api(`movie/${movieId}/credits`, { language: "en-US" }),
      api(`movie/${movieId}/keywords`, {})
    ]);

    modalTitle.textContent = details.title || "Movie";
    modalSubtitle.textContent = [
      details.release_date ? details.release_date.slice(0, 4) : "",
      details.runtime ? `${details.runtime} min` : "",
      details.vote_average ? `⭐ ${details.vote_average.toFixed(1)}` : ""
    ].filter(Boolean).join(" • ");

    const posterHtml = details.poster_path
      ? `<img src="${IMG_BASE}${details.poster_path}" alt="${escapeHtml(details.title)}" />`
      : `<div class="noposter" style="height:320px;">No poster</div>`;

    const genresHtml = (details.genres || []).map(g => pill("genre", g.id, g.name)).join("");
    const cast = (credits.cast || []).slice(0, 10);
    const castHtml = cast.map(p => pill("person", p.id, p.name)).join("");
    const keywords = (keywordData.keywords || keywordData.results || []);
    const keywordsHtml = keywords.slice(0, 12).map(k => pill("keyword", k.id, k.name)).join("");

    modalBody.innerHTML = `
      <div class="poster">${posterHtml}</div>
      <div>
        <div class="overview">${escapeHtml(details.overview || "No overview available.")}</div>

        <div class="sectionTitle">Genres (click to add)</div>
        <div class="pillRow">${genresHtml || "<span class='subtle'>None</span>"}</div>

        <div class="sectionTitle">Top cast (click to add)</div>
        <div class="pillRow">${castHtml || "<span class='subtle'>None</span>"}</div>

        <div class="sectionTitle">Keywords (click to add)</div>
        <div class="pillRow">${keywordsHtml || "<span class='subtle'>None</span>"}</div>

        <div class="subtle" style="margin-top:14px;">
          Tip: click any genre/person/keyword above to refine the search instantly.
        </div>
      </div>
    `;
  } catch (e) {
    modalTitle.textContent = "Error";
    modalSubtitle.textContent = "";
    modalBody.innerHTML = `<div style="padding:16px;">${escapeHtml(e?.message || String(e))}</div>`;
  }
}

async function runSearch() {
  const mySeq = ++searchSeq;

  setStatus("Loading…");
  output.textContent = "Loading…";

  const castIds = selected.filter(t => t.type === "person").map(t => t.id);
  const genreIds = selected.filter(t => t.type === "genre").map(t => t.id);
  const keywordIds = selected.filter(t => t.type === "keyword").map(t => t.id);
  const movieIds = selected.filter(t => t.type === "movie").map(t => t.id);

  // If there's a specific movie selected, just show that movie
  if (movieIds.length) {
    try {
      const movieDetails = await Promise.all(
        movieIds.map(id => api(`movie/${id}`, { language: "en-US" }))
      );
      if (mySeq !== searchSeq) return;
      renderGrid(movieDetails);
      setStatus("Showing " + movieDetails.length + " result" + (movieDetails.length !== 1 ? "s" : ""));
    } catch (e) {
      if (mySeq !== searchSeq) return;
      output.textContent = e?.message || String(e);
      setStatus("Error");
    }
    return;
  }

  const params = {
    include_adult: "false",
    page: "1",
    sort_by: "popularity.desc"
  };

  if (castIds.length) params.with_cast = castIds.join(",");
  if (genreIds.length) params.with_genres = genreIds.join(",");
  if (keywordIds.length) params.with_keywords = keywordIds.join(",");

  try {
    const data = await api("discover/movie", params);
    if (mySeq !== searchSeq) return;
    renderGrid(data.results || []);
    setStatus("Showing " + ((data.results || []).length) + " results");
  } catch (e) {
    if (mySeq !== searchSeq) return;
    output.textContent = e?.message || String(e);
    setStatus("Error");
  }
}

clearBtn.addEventListener("click", () => {
  selected = [];
  renderChips();
  searchInput.value = "";
  showSuggestions(false);
  setStatus("");
  runSearch();
});

async function init() {
  try {
    await loadGenres();
  } catch (e) {
    setStatus(e?.message || String(e));
  }
  runSearch();
}

init();

