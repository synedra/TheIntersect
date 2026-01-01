let currentPage = 1;
let currentGenre = "";
let currentQuery = "";
let totalPages = 0;
let debounceTimer;
let selectedFilters = []; // Array of {type, id, name}


// Dynamically loaded genre list from autocomplete.json
let genreList = [];
let genreSet = new Set();

// Load autocomplete.json and extract genres
fetch("/autocomplete.json")
  .then(r => r.json())
  .then(data => {
    // Support both compact ([type, name, searchName]) and object ({type, name, ...}) formats
    const genres = (Array.isArray(data) ? data : data.entries || data)
      .filter(entry => (Array.isArray(entry) ? entry[0] === 2 : entry.type === "genre" || entry.type === 2))
      .map(entry => Array.isArray(entry) ? entry[1] : entry.name)
      .filter(name => !!name);
    genreSet = new Set(genres);
    genreList = Array.from(genreSet).sort((a, b) => a.localeCompare(b));
  });

const modalOverlay = document.getElementById("modalOverlay");
const modalTitle = document.getElementById("modalTitle");
const modalSubtitle = document.getElementById("modalSubtitle");
const modalBody = document.getElementById("modalBody");
const modalClose = document.getElementById("modalClose");

function renderChips() {
  const chipsContainer = document.getElementById("chips");
  if (!chipsContainer) return;

  chipsContainer.innerHTML = selectedFilters.map(filter => {
    const safeId = String(filter.id).replace(/'/g, "\\'");
    return `
    <span class="chip">
      ${escapeHtml(filter.name)}
      <span class="chipType">${escapeHtml(filter.type)}</span>
      <button type="button" onclick="removeFilter('${safeId}')" aria-label="Remove">×</button>
    </span>
  `}).join("");
  
  // Update currentQuery based on filters
  if (selectedFilters.length > 0) {
    currentQuery = selectedFilters.map(f => f.name).join(" ");
  } else {
    currentQuery = "";
  }
}

window.removeFilter = function(id) {
  // Convert id to string for comparison, as the onclick passes a string
  selectedFilters = selectedFilters.filter(f => String(f.id) !== String(id));
  renderChips();
  loadPage(1);
};

function addFilter(type, id, name) {
  // Check if already exists
  if (!selectedFilters.some(f => String(f.id) === String(id))) {
    selectedFilters.push({ type, id, name });
    renderChips();
    loadPage(1);
  }
}

async function astraApi(action, params = {}) {
  try {
    const url = new URL("/.netlify/functions/astra", window.location.origin);
    url.searchParams.set("action", action);
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error("Error calling astra API:", error);
    throw error;
  }
}

function getGenreName(genreData) {
  if (!genreData || genreData.length === 0) return "Unknown";
  // If genreData is array of objects with .name
  if (typeof genreData[0] === 'object') {
    return genreData.map(g => g.name || "Unknown").join(", ");
  }
  // If genreData is array of strings
  if (typeof genreData[0] === 'string') {
    return genreData.join(", ");
  }
  // If genreData is array of numbers (legacy TMDB IDs), fallback to 'Unknown' or show as-is
  return genreData.map(id => String(id)).join(", ");
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderGrid(movies) {
  const output = document.getElementById("output");
  if (!output) {
    console.error("output element not found");
    return;
  }

  if (!Array.isArray(movies) || movies.length === 0) {
    output.textContent = "No results.";
    return;
  }

  output.innerHTML = `
    <div class="grid">
      ${movies.slice(0, 20).map(m => `
        <div class="card" data-movie-id="${m.id}">
          ${m.poster_path
            ? `<img src="https://image.tmdb.org/t/p/w500${m.poster_path}" alt="${escapeHtml(m.title)}" />`
            : `<div class="noposter">No poster</div>`
          }
          <div class="movieTitle">${escapeHtml(m.title)}</div>
          <div class="meta">${m.release_date ? new Date(m.release_date).getFullYear() : ""}</div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderPagination(page, total) {
  const container = document.getElementById("pagination");
  if (!container) return;

  container.innerHTML = "";

  if (total <= 1) return;

  const maxVisible = 5;
  let startPage = Math.max(1, page - Math.floor(maxVisible / 2));
  let endPage = Math.min(total, startPage + maxVisible - 1);

  if (endPage - startPage + 1 < maxVisible) {
    startPage = Math.max(1, endPage - maxVisible + 1);
  }

  const prevBtn = document.createElement("button");
  prevBtn.textContent = "Previous";
  prevBtn.disabled = page === 1;
  prevBtn.addEventListener("click", () => {
    if (page > 1) loadPage(page - 1);
  });
  container.appendChild(prevBtn);

  if (startPage > 1) {
    const firstBtn = document.createElement("button");
    firstBtn.textContent = "1";
    firstBtn.addEventListener("click", () => loadPage(1));
    container.appendChild(firstBtn);

    if (startPage > 2) {
      const ellipsis = document.createElement("span");
      ellipsis.textContent = "...";
      ellipsis.className = "ellipsis";
      container.appendChild(ellipsis);
    }
  }

  for (let i = startPage; i <= endPage; i++) {
    const pageBtn = document.createElement("button");
    pageBtn.textContent = i;
    if (i === page) {
      pageBtn.classList.add("active");
    }
    pageBtn.addEventListener("click", () => loadPage(i));
    container.appendChild(pageBtn);
  }

  if (endPage < total) {
    if (endPage < total - 1) {
      const ellipsis = document.createElement("span");
      ellipsis.textContent = "...";
      ellipsis.className = "ellipsis";
      container.appendChild(ellipsis);
    }

    const lastBtn = document.createElement("button");
    lastBtn.textContent = total;
    lastBtn.addEventListener("click", () => loadPage(total));
    container.appendChild(lastBtn);
  }

  const nextBtn = document.createElement("button");
  nextBtn.textContent = "Next";
  nextBtn.disabled = page === total;
  nextBtn.addEventListener("click", () => {
    if (page < total) loadPage(page + 1);
  });
  container.appendChild(nextBtn);
}

async function loadPage(page = 1) {
  // For now, Astra DB only supports showing first 20 movies
  currentPage = 1;
  const output = document.getElementById("output");
  if (output) {
    output.innerHTML = "Loading…";
  }

  try {
    let data;
    
    // Check selectedFilters for person or genre filters
    const personFilter = selectedFilters.find(f => f.type === "person");
    const genreFilter = selectedFilters.find(f => f.type === "genre");
    const textFilter = selectedFilters.find(f => f.type === "text");
    
    if (textFilter) {
      data = await astraApi("search", { query: textFilter.name });
    } else if (personFilter) {
      // Use person filter endpoint instead of vector search
      data = await astraApi("person", { name: personFilter.name });
    } else if (genreFilter) {
      data = await astraApi("genre", { genre: genreFilter.name });
    } else if (currentQuery) {
      data = await astraApi("search", { query: currentQuery });
    } else if (currentGenre) {
      data = await astraApi("genre", { genre: currentGenre });
    } else {
      data = await astraApi("popular");
    }

    if (data && data.results) {
      totalPages = data.total_pages || 1;
      renderGrid(data.results);
      // Disable pagination for now since Astra DB doesn't support skip/limit
      // renderPagination(currentPage, totalPages);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      console.error("No data or results received:", data);
    }
  } catch (error) {
    console.error("Error loading page:", error);
    const output = document.getElementById("output");
    if (output) {
      output.textContent = "Error loading movies. Please try again.";
    }
  }
}

async function openMovieModal(movieId) {
  openModal();
  modalTitle.textContent = "Loading…";
  modalSubtitle.textContent = "";
  modalBody.innerHTML = "";

  try {
    const data = await astraApi("details", { id: movieId });

    if (!data) {
      modalTitle.textContent = "Movie not found";
      modalBody.innerHTML = "<div style='padding:16px;'>Movie not found.</div>";
      return;
    }

    console.log("Movie Details Data:", data);

    modalTitle.textContent = data.title || "Movie";
    modalSubtitle.textContent = [
      data.release_date ? new Date(data.release_date).getFullYear() : "",
      data.runtime ? `${data.runtime} min` : "",
      data.vote_average ? `⭐ ${data.vote_average.toFixed(1)} (${data.vote_count || 0} votes)` : "",
      data.popularity ? `📈 ${Math.round(data.popularity)}` : ""
    ].filter(Boolean).join(" • ");

    const posterHtml = data.poster_path
      ? `<img src="https://image.tmdb.org/t/p/w500${data.poster_path}" alt="${escapeHtml(data.title)}" />`
      : `<div class="noposter" style="height:320px;">No poster</div>`;

    // Handle genres (array of objects or strings)
    let genresHtml = "";
    if (Array.isArray(data.genres)) {
      genresHtml = data.genres.map(g => 
        typeof g === 'object' ? `<span class="pill genre-pill">${escapeHtml(g.name)}</span>` : `<span class="pill genre-pill">${escapeHtml(g)}</span>`
      ).join("");
    }

    // Handle watch providers (US default)
    let providersHtml = "";
    if (data.watch_providers && data.watch_providers.US && data.watch_providers.US.stream) {
      providersHtml = data.watch_providers.US.stream.map(p => 
        `<span class="pill provider-pill" style="background:#e0e7ff; border-color:#c7d2fe; color:#3730a3;">${escapeHtml(p)}</span>`
      ).join("");
    } else if (data.watch_providers && data.watch_providers.US && data.watch_providers.US.rent) {
       // Fallback to rent if no stream
       providersHtml = data.watch_providers.US.rent.slice(0, 3).map(p => 
        `<span class="pill provider-pill" style="background:#f3f4f6; border-color:#e5e7eb; color:#374151;">Rent: ${escapeHtml(p)}</span>`
      ).join("");
    }

    // Handle cast
    let castHtml = "";
    const castList = Array.isArray(data.cast) ? data.cast : (data.credits?.cast || []);
    
    if (castList.length > 0) {
      castHtml = castList.slice(0, 10).map(c => {
        const name = typeof c === 'object' ? c.name : c;
        const character = (typeof c === 'object' && c.character) ? c.character : "";
        return `
          <div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #f0f0f0; font-size:13px;">
            <span class="cast-link" data-name="${escapeHtml(name)}" style="font-weight:500; color:#2563eb; cursor:pointer;">${escapeHtml(name)}</span>
            <span style="color:#666; text-align:right; margin-left:12px;">${escapeHtml(character)}</span>
          </div>
        `;
      }).join("");
    }

    // Handle keywords
    let keywordsHtml = "";
    if (Array.isArray(data.keywords)) {
      keywordsHtml = data.keywords.slice(0, 12).map(k => 
        typeof k === 'object' ? `<span class="pill keyword-pill">${escapeHtml(k.name)}</span>` : `<span class="pill keyword-pill">${escapeHtml(k)}</span>`
      ).join("");
    }

    modalBody.innerHTML = `
      <div class="poster">${posterHtml}</div>
      <div>
        <div class="overview">${escapeHtml(data.overview || "No overview available.")}</div>

        ${genresHtml ? `
        <div class="sectionTitle">Genres</div>
        <div style="margin-top:8px;">${genresHtml}</div>
        ` : ''}

        ${castHtml ? `
        <div class="sectionTitle">Top Cast</div>
        <div style="margin-top:8px;">${castHtml}</div>
        ` : ''}

        ${keywordsHtml ? `
        <div class="sectionTitle">Keywords</div>
        <div class="pillRow">${keywordsHtml}</div>
        ` : ''}

        ${providersHtml ? `
        <div class="sectionTitle">Where to Watch</div>
        <div class="pillRow">${providersHtml}</div>
        ` : ''}

        <div class="subtle" style="margin-top:14px;">
          Click on any movie in the main grid to see its details.
        </div>
      </div>
      
      <div id="similar-movies-container" style="grid-column: 1 / -1; margin-top: 24px; border-top: 1px solid #eee; padding-top: 16px;">
        <h3 class="sectionTitle" style="margin-bottom: 12px;">Similar Movies</h3>
        <div id="similar-movies-grid" style="display: flex; gap: 12px; overflow-x: auto; padding-bottom: 8px;">
          <div class="subtle">Loading...</div>
        </div>
      </div>
    `;

    loadSimilarMovies(movieId);

    // Add click handlers for cast names to filter by actor
    modalBody.querySelectorAll(".cast-link").forEach(link => {
      link.addEventListener("click", () => {
        const actorName = link.getAttribute("data-name");
        addFilter("person", actorName, actorName);
        renderChips();
        loadPage(1);
        closeModal();
      });
    });

    // Add click handlers for genre pills
    modalBody.querySelectorAll(".genre-pill").forEach(pill => {
      pill.style.cursor = 'pointer';
      pill.addEventListener("click", () => {
        const genreName = pill.textContent;
        addFilter("genre", genreName, genreName);
        renderChips();
        loadPage(1);
        closeModal();
      });
    });

    // Add click handlers for keyword pills
    modalBody.querySelectorAll(".keyword-pill").forEach(pill => {
      pill.style.cursor = 'pointer';
      pill.addEventListener("click", () => {
        const keyword = pill.textContent;
        addFilter("text", keyword, keyword);
        renderChips();
        loadPage(1);
        closeModal();
      });
    });

    // Add click handlers for provider pills
    modalBody.querySelectorAll(".provider-pill").forEach(pill => {
      pill.style.cursor = 'pointer';
      pill.addEventListener("click", () => {
        const provider = pill.textContent.replace(/^Rent: /, '');
        addFilter("text", provider, provider);
        renderChips();
        loadPage(1);
        closeModal();
      });
    });

  } catch (error) {
    console.error("Error loading movie details:", error);
    modalTitle.textContent = "Error";
    modalBody.innerHTML = "<div style='padding:16px;'>Error loading movie details. Please try again.</div>";
  }
}

async function loadSimilarMovies(movieId) {
  const container = document.getElementById("similar-movies-grid");
  if (!container) return;
  
  try {
    const data = await astraApi("similar", { id: movieId, limit: 10 });
    if (!data || !data.results || data.results.length === 0) {
      container.innerHTML = "<div class='subtle'>No similar movies found.</div>";
      return;
    }
    
    container.innerHTML = data.results.map(m => `
      <div class="card similar-card" data-movie-id="${m.id}" style="min-width: 100px; width: 100px; cursor: pointer; border:none; box-shadow:none; background:transparent;">
        <img src="${m.poster_path ? 'https://image.tmdb.org/t/p/w154' + m.poster_path : ''}" 
             alt="${escapeHtml(m.title)}" 
             style="width:100%; border-radius:8px; aspect-ratio: 2/3; object-fit: cover; background: #eee;">
        <div style="font-size:11px; margin-top:4px; line-height:1.2; max-height:2.4em; overflow:hidden; text-align:center;">${escapeHtml(m.title)}</div>
      </div>
    `).join("");
    
    container.querySelectorAll(".similar-card").forEach(card => {
      card.addEventListener("click", () => {
        const newId = card.getAttribute("data-movie-id");
        openMovieModal(newId);
      });
    });

  } catch (e) {
    console.error(e);
    container.innerHTML = "<div class='subtle'>Error loading similar movies.</div>";
  }
}

function openModal() {
  modalOverlay.classList.add("open");
  modalOverlay.setAttribute("aria-hidden", "false");
}

function closeModal() {
  modalOverlay.classList.remove("open");
  modalOverlay.setAttribute("aria-hidden", "true");
  modalBody.innerHTML = "";
}

// In-memory autocomplete data (loaded once on page start)
let autocompleteData = null;
const AUTOCOMPLETE_TYPES = ["movie", "person", "genre"];

async function loadAutocompleteData() {
  try {
    const startTime = performance.now();
    const response = await fetch("/autocomplete.json");
    if (!response.ok) throw new Error("Failed to load autocomplete data");
    const data = await response.json();
    // Support both flat array ([type, name, searchName, icon?]) and object format ({type, name, ...})
    const entries = Array.isArray(data) ? data : (data.entries || data);
    autocompleteData = entries.map(entry => {
      if (Array.isArray(entry)) {
        // [typeCode, name, searchName, icon?]
        const [typeCode, name, searchName, icon] = entry;
        const obj = {
          type: AUTOCOMPLETE_TYPES[typeCode] || "movie",
          name,
          searchName
        };
        if (icon) obj.icon = icon;
        return obj;
      } else {
        // {type, name, searchName, icon?}
        const { type, name, searchName, icon } = entry;
        const obj = {
          type: typeof type === 'number' ? (AUTOCOMPLETE_TYPES[type] || "movie") : (type || "movie"),
          name,
          searchName
        };
        if (icon) obj.icon = icon;
        return obj;
      }
    });
    
    console.log(`[Autocomplete] Loaded ${autocompleteData.length} entries in ${(performance.now() - startTime).toFixed(0)}ms`);
  } catch (error) {
    console.error("Failed to load autocomplete data:", error);
    autocompleteData = [];
  }
}

function filterAutocomplete(query) {
  if (!autocompleteData || query.length < 2) return [];
  
  const startTime = performance.now();
  const qLower = query.toLowerCase();
  console.log(`[Autocomplete] Filtering for query "${query}" (${qLower})`);
  
  // Filter entries where searchName starts with query (prefix match)
  const results = autocompleteData
    .filter(entry => entry.searchName.startsWith(qLower))
    .slice(0, 15);  // Limit results
  
  console.log(`[Autocomplete] Filtered to ${results.length} matches in ${(performance.now() - startTime).toFixed(1)}ms`);
  return results;
}

async function setupAutocomplete() {
  const searchInput = document.getElementById("searchInput");
  const autocompleteList = document.getElementById("suggestions");

  if (!searchInput || !autocompleteList) return;

  // Load autocomplete data on setup
  await loadAutocompleteData();

  let selectedIndex = -1;

  // Keyboard navigation for autocomplete
  searchInput.addEventListener("keydown", (e) => {
    const items = autocompleteList.querySelectorAll(".resultItem");
    if (items.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
      updateSelection(items);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      updateSelection(items);
    } else if (e.key === "Enter" && selectedIndex >= 0) {
      e.preventDefault();
      items[selectedIndex].click();
      selectedIndex = -1;
    } else if (e.key === "Escape") {
      autocompleteList.innerHTML = "";
      autocompleteList.style.display = "none";
      selectedIndex = -1;
    }
  });

  function updateSelection(items) {
    items.forEach((item, i) => {
      if (i === selectedIndex) {
        item.classList.add("selected");
        item.scrollIntoView({ block: "nearest" });
      } else {
        item.classList.remove("selected");
      }
    });
  }

  searchInput.addEventListener("input", (e) => {
    const query = e.target.value.trim();
    selectedIndex = -1; // Reset selection on new input

    if (query.length < 2) {
      autocompleteList.innerHTML = "";
      autocompleteList.style.display = "none";
      return;
    }

    // Instant filtering - no debounce needed with in-memory data!
    const results = filterAutocomplete(query);
    
    autocompleteList.innerHTML = "";

    if (results.length > 0) {
      results.forEach((result) => {
        const item = document.createElement("div");
        item.className = "resultItem";

        // Build thumbnail if icon is present
        let thumbHtml = "";
        if (result.icon) {
          thumbHtml = `<img src="${escapeHtml(result.icon)}" alt="icon" class="autocomplete-thumb" style="width:32px;height:32px;object-fit:cover;border-radius:4px;margin-right:8px;vertical-align:middle;">`;
        }

        if (result.type === "person") {
          item.innerHTML = `
            <div style="display:flex;align-items:center;">
              ${thumbHtml}
              <div style="flex: 1;">
                <div style="font-size: 14px;">${!thumbHtml ? '👤 ' : ''}${escapeHtml(result.name)}</div>
                <div class="suggestionType">Person</div>
              </div>
            </div>
          `;
          item.addEventListener("click", () => {
            addFilter("person", result.name, result.name);
            searchInput.value = "";
            autocompleteList.innerHTML = "";
            autocompleteList.style.display = "none";
            closeModal();
          });
        } else if (result.type === "genre") {
          item.innerHTML = `
            <div style="display:flex;align-items:center;">
              ${thumbHtml}
              <div style="flex: 1;">
                <div style="font-size: 14px;">${!thumbHtml ? '🏷️ ' : ''}${escapeHtml(result.name)}</div>
                <div class="suggestionType">Genre</div>
              </div>
            </div>
          `;
          item.addEventListener("click", () => {
            addFilter("genre", result.name, result.name);
            searchInput.value = "";
            autocompleteList.innerHTML = "";
            autocompleteList.style.display = "none";
            closeModal();
          });
        } else {
          // Movie
          item.innerHTML = `
            <div style="display:flex;align-items:center;">
              ${thumbHtml}
              <div style="flex: 1;">
                <div style="font-size: 14px;">${!thumbHtml ? '🎬 ' : ''}${escapeHtml(result.title || result.name)}</div>
                <div class="suggestionType">Movie</div>
              </div>
            </div>
          `;
          item.addEventListener("click", () => {
            // For movies, add as text filter to search
            addFilter("text", result.title || result.name, result.title || result.name);
            searchInput.value = "";
            autocompleteList.innerHTML = "";
            autocompleteList.style.display = "none";
            closeModal();
          });
        }

        autocompleteList.appendChild(item);
      });

      autocompleteList.style.display = "block";
    } else {
      autocompleteList.style.display = "none";
    }
  });

  document.addEventListener("click", (e) => {
    if (e.target !== searchInput && !autocompleteList.contains(e.target)) {
      autocompleteList.innerHTML = "";
      autocompleteList.style.display = "none";
    }
  });
}

function setupProviders() {
  const providersContainer = document.getElementById("providers");
  if (!providersContainer) return;

  // Common streaming providers - we can expand this list later
  const providers = [
    "Netflix",
    "Amazon Prime Video", 
    "Disney+",
    "Hulu",
    "HBO Max",
    "Apple TV+",
    "Paramount+",
    "Peacock",
    "Crunchyroll",
    "YouTube",
    "Tubi",
    "Pluto TV"
  ];

  providersContainer.innerHTML = providers.map(provider => 
    `<span class="pill provider-nav-pill">${escapeHtml(provider)}</span>`
  ).join("");

  // Add click handlers
  providersContainer.querySelectorAll(".provider-nav-pill").forEach(pill => {
    pill.style.cursor = 'pointer';
    pill.addEventListener("click", () => {
      const providerName = pill.textContent;
      addFilter("text", providerName, providerName);
      renderChips();
      loadPage(1);
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  loadPage(1);
  setupAutocomplete();
  setupProviders();

  // const searchForm = document.getElementById("search-form");
  const searchInput = document.getElementById("searchInput");
  const genreFilter = document.getElementById("genre-filter");
  // const modalClose = document.querySelector(".modal-close");
  // const modal = document.getElementById("movie-modal");

  if (searchInput) {
    searchInput.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        const autocompleteList = document.getElementById("suggestions");
        const selectedItem = autocompleteList?.querySelector(".resultItem.selected");
        
        // If there's a selected autocomplete item, let the autocomplete handler deal with it
        if (selectedItem) {
          return;
        }
        
        e.preventDefault();
        const query = searchInput.value.trim();

        if (query.length < 2) {
          alert("Please enter at least 2 characters to search.");
          return;
        }

        // Add as a text filter
        addFilter("text", query, query);
        searchInput.value = "";

        if (autocompleteList) {
          autocompleteList.innerHTML = "";
          autocompleteList.style.display = "none";
        }
      }
    });
  }

  const clearButton = document.getElementById("clear");
  if (clearButton) {
    clearButton.addEventListener("click", () => {
      selectedFilters = [];
      renderChips();
      loadPage(1);
    });
  }

  if (genreFilter) {
    genreFilter.addEventListener("change", (e) => {
      currentGenre = e.target.value;
      currentQuery = "";
      if (searchInput) searchInput.value = "";
      loadPage(1);
    });
  }

  if (modalClose) {
    modalClose.addEventListener("click", closeModal);
  }

  if (modalOverlay) {
    modalOverlay.addEventListener("click", (e) => {
      if (e.target === modalOverlay) closeModal();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modalOverlay.classList.contains("open")) closeModal();
  });
});

// Click movie card -> open modal
document.getElementById("output").addEventListener("click", (e) => {
  const card = e.target.closest(".card[data-movie-id]");
  if (!card) return;
  const movieId = card.getAttribute("data-movie-id");
  openMovieModal(movieId);
});

