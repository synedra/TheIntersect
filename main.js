// COMMAND TO KILL PORT 5173:
// lsof -ti:5173 | xargs kill -9

// TMDB Authentication
const TMDB_AUTH_API = "/.netlify/functions/tmdb_auth";

const updateUI = async () => {
  const sessionId = localStorage.getItem("tmdb_session_id");
  const btnLogin = document.getElementById("btn-login");
  const btnLogout = document.getElementById("btn-logout");
  const userProfile = document.getElementById("user-profile");

  if (sessionId) {
    // Fetch account details
    try {
        const res = await fetch(`${TMDB_AUTH_API}?action=get_account&session_id=${sessionId}`);
        const user = await res.json();
        
        if (user.success === false) {
             // Session invalid
             localStorage.removeItem("tmdb_session_id");
             updateUI();
             return;
        }

        if (btnLogin) btnLogin.style.display = "none";
        if (btnLogout) btnLogout.style.display = "block";
        if (userProfile) {
            userProfile.style.display = "block";
            userProfile.innerHTML = `Logged in as <b>${user.username || "User"}</b>`;
        }
    } catch (e) {
        console.error("Error fetching account", e);
    }
  } else {
    if (btnLogin) btnLogin.style.display = "block";
    if (btnLogout) btnLogout.style.display = "none";
    if (userProfile) userProfile.style.display = "none";
  }
};

const login = async () => {
  try {
      const res = await fetch(`${TMDB_AUTH_API}?action=request_token`);
      const data = await res.json();
      if (data.success && data.request_token) {
          window.location.href = `https://www.themoviedb.org/authenticate/${data.request_token}?redirect_to=${window.location.href}`;
      } else {
          console.error("Failed to get request token", data);
          alert("Login failed: Could not get request token.");
      }
  } catch (e) {
      console.error(e);
      alert("Login failed: " + e.message);
  }
};

const logout = async () => {
  const sessionId = localStorage.getItem("tmdb_session_id");
  if (sessionId) {
      try {
        await fetch(`${TMDB_AUTH_API}?action=logout`, {
            method: "POST",
            body: JSON.stringify({ session_id: sessionId })
        });
      } catch (e) {
          console.warn("Logout failed on server", e);
      }
      localStorage.removeItem("tmdb_session_id");
      updateUI();
  }
};

const handleTmdbCallback = async () => {
    const params = new URLSearchParams(window.location.search);
    const requestToken = params.get("request_token");
    const approved = params.get("approved");

    if (requestToken && approved === "true") {
        try {
            const res = await fetch(`${TMDB_AUTH_API}?action=create_session`, {
                method: "POST",
                body: JSON.stringify({ request_token: requestToken })
            });
            const data = await res.json();
            if (data.success && data.session_id) {
                localStorage.setItem("tmdb_session_id", data.session_id);
                // Clean URL
                const newUrl = window.location.origin + window.location.pathname;
                window.history.replaceState({}, document.title, newUrl);
                await updateUI();
            } else {
                console.error("Failed to create session", data);
            }
        } catch (e) {
            console.error("Error creating session", e);
        }
    }
};

let currentPage = 1;
let currentGenre = "";
let currentQuery = "";
let totalPages = 0;
let debounceTimer;
let selectedFilters = []; // Array of {type, id, name}
let selectedProviders = new Set();
let searchMode = { stream: true, rentBuy: false, movies: true, tvshows: false };

// Common streaming providers configuration
const PROVIDER_CONFIG = [
  { name: "Netflix", logo: "/netflix_logo.jpg", url: "https://www.netflix.com" },
  { name: "Amazon Prime Video", logo: "/amazon_prime.jpg", url: "https://www.amazon.com/Prime-Video/b?node=2676882011" },
  { name: "Disney+", logo: "/disney.jpg", url: "https://www.disneyplus.com" },
  { name: "Hulu", logo: "/hulu.jpg", url: "https://www.hulu.com" },
  { name: "HBO Max", logo: "/hbomax.jpg", url: "https://www.max.com" },
  { name: "Apple TV+", logo: "/appletv.jpg", url: "https://tv.apple.com" },
  { name: "Paramount+", logo: "/paramount.jpg", url: "https://www.paramountplus.com" },
  { name: "Peacock", logo: "/peacock.jpg", url: "https://www.peacocktv.com" },
  { name: "Crunchyroll", logo: "/crunchyroll.jpg", url: "https://www.crunchyroll.com" },
  { name: "YouTube", logo: "/youtube.jpg", url: "https://www.youtube.com" },
  { name: "Tubi", logo: "/tubi.jpg", url: "https://tubitv.com" },
  { name: "Pluto TV", logo: "/pluto.jpg", url: "https://pluto.tv" }
];

function getProviderLogo(name) {
  const config = PROVIDER_CONFIG.find(p => p.name === name || name.includes(p.name));
  return config ? config.logo : null;
}

function getProviderUrl(name) {
  const config = PROVIDER_CONFIG.find(p => p.name === name || name.includes(p.name));
  return config ? config.url : `https://www.google.com/search?q=${encodeURIComponent(name + " watch")}`;
}



// Dynamically loaded genre list from autocomplete.json
let genreList = [];
let genreSet = new Set();

// Load autocomplete.json and extract genres
fetch("/autocomplete.json")
  .then(r => {
      if (!r.ok) throw new Error("Failed to load autocomplete data");
      return r.json();
  })
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

// Mobile Sidebar Logic
const mobileFilterBtn = document.getElementById("mobile-filter-btn");
const mobileCloseSidebarBtn = document.getElementById("mobile-close-sidebar");
const sidebar = document.getElementById("sidebar");

if (mobileFilterBtn && sidebar) {
  mobileFilterBtn.addEventListener("click", () => {
    sidebar.classList.add("open");
    document.body.style.overflow = "hidden"; // Prevent background scrolling
  });
}

if (mobileCloseSidebarBtn && sidebar) {
  mobileCloseSidebarBtn.addEventListener("click", () => {
    sidebar.classList.remove("open");
    document.body.style.overflow = "";
  });
}

function renderChips() {
  const chipsContainer = document.getElementById("chips");
  if (!chipsContainer) return;

  updateLanguageLabel();

  chipsContainer.innerHTML = selectedFilters.map(filter => {
    const safeId = String(filter.id).replace(/'/g, "\\'");
    return `
    <span class="chip">
      ${escapeHtml(filter.name)}
      <span class="chipType">${escapeHtml(filter.type)}</span>
      <button type="button" onclick="removeFilter('${safeId}')" aria-label="Remove">×</button>
    </span>
  `}).join("");
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
    
    // On mobile, we might want to keep the sidebar open to add more filters, 
    // or close it to see results. Let's keep it open but maybe scroll to top?
    // Actually, user might want to see results. Let's auto-close if it's a "search" action (text/movie)
    // but keep open for "provider" or "genre" toggles? 
    // For now, let's just keep it open so they can stack filters.
  }
}
window.addFilter = addFilter;

window.showChatSuggestion = function(titles) {
  // Ensure titles is an array
  const titleList = Array.isArray(titles) ? titles : [titles];
  if (titleList.length === 0) return;

  console.log("showChatSuggestion called for:", titleList);
  
  // Remove existing toast if any
  const existing = document.getElementById("chat-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "chat-toast";
  toast.className = "toast";
  
  // Build HTML based on number of titles
  if (titleList.length === 1) {
    const title = titleList[0];
    toast.innerHTML = `
      <span>Search for "<b>${escapeHtml(title)}</b>"?</span>
      <button class="toast-close" style="background:transparent; border:none; color:#aaa; cursor:pointer; margin-left:8px; font-size:16px;">&times;</button>
    `;
    toast.onclick = (e) => {
      if (e.target.closest('.toast-close')) {
        toast.remove();
        return;
      }
      console.log("Toast clicked, adding filter:", title);
      addFilter("text", title, title);
      toast.remove();
    };
  } else {
    // Multiple titles
    toast.style.flexDirection = "column";
    toast.style.alignItems = "flex-start";
    toast.style.gap = "8px";
    
    let html = `
      <div style="display:flex; justify-content:space-between; width:100%; align-items:center;">
        <span>Found ${titleList.length} movies:</span>
        <button class="toast-close" style="background:transparent; border:none; color:#aaa; cursor:pointer; font-size:16px;">&times;</button>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:6px;">
    `;
    
    titleList.forEach(title => {
      html += `<button class="toast-chip" data-title="${escapeHtml(title)}" style="background:#444; border:1px solid #555; color:white; padding:4px 10px; border-radius:12px; cursor:pointer; font-size:12px;">${escapeHtml(title)}</button>`;
    });
    
    html += `</div>`;
    toast.innerHTML = html;
    
    toast.onclick = (e) => {
      if (e.target.closest('.toast-close')) {
        toast.remove();
        return;
      }
      const chip = e.target.closest('.toast-chip');
      if (chip) {
        const title = chip.getAttribute('data-title');
        console.log("Toast chip clicked, adding filter:", title);
        // Let's just add it for now.
        addFilter("text", title, title);
        // Don't remove toast immediately so they can click others? 
        // Or remove it? Let's remove it to be clean.
        // toast.remove(); 
      }
    };
  }

  document.body.appendChild(toast);
  console.log("Toast appended to body", toast);
  
  // Auto remove after 15s (longer for multiple)
  setTimeout(() => {
    if (toast.parentElement) toast.remove();
  }, 15000);
};

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

function getLanguageName(code) {
  const languageMap = {
    'af': 'Afrikaans', 'am': 'Amharic', 'ar': 'Arabic', 'bg': 'Bulgarian', 'bn': 'Bengali',
    'ca': 'Catalan', 'cn': 'Cantonese', 'cs': 'Czech', 'cy': 'Welsh', 'da': 'Danish',
    'de': 'German', 'dv': 'Divehi', 'el': 'Greek', 'en': 'English', 'es': 'Spanish',
    'et': 'Estonian', 'eu': 'Basque', 'fa': 'Persian', 'fi': 'Finnish', 'fr': 'French',
    'gl': 'Galician', 'gu': 'Gujarati', 'he': 'Hebrew', 'hi': 'Hindi', 'hr': 'Croatian',
    'hu': 'Hungarian', 'hy': 'Armenian', 'id': 'Indonesian', 'is': 'Icelandic', 'it': 'Italian',
    'ja': 'Japanese', 'ka': 'Georgian', 'kk': 'Kazakh', 'ko': 'Korean', 'ku': 'Kurdish',
    'lt': 'Lithuanian', 'lv': 'Latvian', 'ml': 'Malayalam', 'ms': 'Malay', 'nb': 'Norwegian Bokmål',
    'nl': 'Dutch', 'no': 'Norwegian', 'pa': 'Punjabi', 'pl': 'Polish', 'pt': 'Portuguese',
    'ro': 'Romanian', 'ru': 'Russian', 'sr': 'Serbian', 'sv': 'Swedish', 'ta': 'Tamil',
    'te': 'Telugu', 'th': 'Thai', 'tl': 'Tagalog', 'tr': 'Turkish', 'uk': 'Ukrainian',
    'ur': 'Urdu', 'uz': 'Uzbek', 'xx': 'Unknown', 'zh': 'Chinese'
  };
  return languageMap[code] || code.toUpperCase();
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
    if (selectedProviders.size > 0) {
      const providersList = Array.from(selectedProviders).join(", ");
      output.textContent = `No results from selected providers (${providersList})`;
    } else {
      output.textContent = "No results.";
    }
    return;
  }

  output.innerHTML = `
    <div class="grid">
      ${movies.slice(0, 20).map(m => {
        const title = m.name || m.title;
        const releaseDate = m.first_air_date || m.release_date;
        return `
        <div class="card" data-movie-id="${m.id}">
          ${m.poster_path
            ? `<img src="https://image.tmdb.org/t/p/w500${m.poster_path}" alt="${escapeHtml(title)}" />`
            : `<div class="noposter">No poster</div>`
          }
          <div class="movieTitle">${escapeHtml(title)}</div>
          <div class="meta">
            ${releaseDate ? new Date(releaseDate).getFullYear() : ""}
            ${m.vote_average ? ` • ⭐ ${m.vote_average.toFixed(1)}` : ""}
          </div>
        </div>
      `}).join("")}
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
    
    // Collect all filters
    const personFilters = selectedFilters.filter(f => f.type === "person").map(f => f.name);
    const genreFilters = selectedFilters.filter(f => f.type === "genre").map(f => f.name);
    const keywordFilters = selectedFilters.filter(f => f.type === "keyword").map(f => f.name);
    const languageFilters = selectedFilters.filter(f => f.type === "language").map(f => f.id);
    // Treat movie filters as text searches (using name/title) so we find other movies with same title
    const movieFilters = selectedFilters.filter(f => f.type === "movie").map(f => f.name);
    const textFilters = selectedFilters.filter(f => f.type === "text").map(f => f.name);
    const providers = Array.from(selectedProviders);

    const params = {};
    if (personFilters.length > 0) params.person = personFilters.join(",");
    if (genreFilters.length > 0) params.genre = genreFilters.join(",");
    if (keywordFilters.length > 0) params.keywords = keywordFilters.join(",").replace(/\+/g, '%2B');
    if (languageFilters.length > 0) params.language = languageFilters.join(",");
    
    // Add content type filtering
    const contentTypes = [];
    if (searchMode.movies) contentTypes.push('movies');
    if (searchMode.tvshows) contentTypes.push('tvshows');
    const contentTypesStr = contentTypes.length > 0 ? contentTypes.join(",") : "";
    
    // Combine text and movie title filters into query
    const allTextQueries = [...textFilters, ...movieFilters];
    if (allTextQueries.length > 0) params.query = allTextQueries.join(" ").replace(/\+/g, '%2B');
    if (providers.length > 0) {
        params.providers = providers.join(",").replace(/\+/g, '%2B');
        
        const paymentTypes = [];
        if (searchMode.stream) paymentTypes.push('stream');
        if (searchMode.rentBuy) paymentTypes.push('rent', 'buy');
        if (paymentTypes.length > 0) params.payment_types = paymentTypes.join(",");
    }
    
    // Also handle legacy currentGenre if it exists and isn't covered
    if (currentGenre && genreFilters.length === 0) params.genre = currentGenre;

    // Check if we have any actual filters (not just content_types)
    const hasFilters = Object.keys(params).length > 0;
    
    // Add content_types to all requests
    const contentTypesParam = contentTypesStr ? { content_types: contentTypesStr } : {};
    
    if (hasFilters) {
      // Has filters, call search
      console.log('[LoadPage] Calling search with params:', { ...params, ...contentTypesParam });
      data = await astraApi("search", { ...params, ...contentTypesParam });
    } else {
      // No filters, call discover
      console.log('[LoadPage] Calling discover with params:', contentTypesParam);
      data = await astraApi("discover", contentTypesParam);
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
      modalTitle.textContent = "Content not found";
      modalBody.innerHTML = "<div style='padding:16px;'>Content not found.</div>";
      return;
    }

    console.log("Details Data:", data);
    
    const isTVShow = data.content_type === 'tv';
    const title = isTVShow ? data.name : data.title;
    const releaseDate = isTVShow ? data.first_air_date : data.release_date;

    modalTitle.textContent = title || (isTVShow ? "TV Show" : "Movie");
    
    const subtitleParts = [
      releaseDate ? new Date(releaseDate).getFullYear() : "",
      isTVShow && data.number_of_seasons ? `${data.number_of_seasons} Season${data.number_of_seasons > 1 ? 's' : ''}` : "",
      !isTVShow && data.runtime ? `${data.runtime} min` : "",
      data.vote_average ? `⭐ ${data.vote_average.toFixed(1)} (${data.vote_count || 0} votes)` : "",
      data.popularity ? `📈 ${Math.round(data.popularity)}` : ""
    ].filter(Boolean).join(" • ");
    
    modalSubtitle.textContent = subtitleParts;

    const posterHtml = data.poster_path
      ? `<img src="https://image.tmdb.org/t/p/w500${data.poster_path}" alt="${escapeHtml(title)}" />`
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
    if (data.watch_providers && data.watch_providers.US) {
      const us = data.watch_providers.US;
      const providerMap = {};

      // Helper to add to map
      const addToMap = (list, type) => {
        if (list && list.length > 0) {
          list.forEach(p => {
            if (!providerMap[p]) providerMap[p] = new Set();
            providerMap[p].add(type);
          });
        }
      };

      addToMap(us.stream, 'Stream');
      addToMap(us.rent, 'Rent');
      addToMap(us.buy, 'Buy');

      if (Object.keys(providerMap).length > 0) {
        providersHtml = `
          <table style="width:100%; border-collapse: collapse; margin-top:8px; font-size:13px;">
            <thead>
              <tr style="border-bottom: 1px solid #eee; text-align:left;">
                <th style="padding:8px 4px; font-weight:600; color:#555;">Provider</th>
                <th style="padding:8px 4px; font-weight:600; color:#555;">Availability</th>
              </tr>
            </thead>
            <tbody>
              ${Object.entries(providerMap).map(([name, types]) => {
                const logo = getProviderLogo(name);
                const url = getProviderUrl(name);
                const typeList = Array.from(types).sort().join(', ');
                
                return `
                  <tr class="provider-row" data-provider="${escapeHtml(name)}" style="border-bottom: 1px solid #f9f9f9;">
                    <td style="padding:8px 4px;">
                      <a href="${url}" target="_blank" rel="noopener noreferrer" style="display:flex; align-items:center; gap:8px; text-decoration:none; color:#222;">
                        ${logo ? `<img src="${logo}" alt="${escapeHtml(name)}" style="width:24px; height:24px; object-fit:contain; border-radius:4px;">` : ''}
                        <span style="font-weight:500;">${escapeHtml(name)}</span>
                      </a>
                    </td>
                    <td style="padding:8px 4px; color:#666;">${typeList}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        `;
      }
    }

    // Handle cast
    let castHtml = "";
    const castList = Array.isArray(data.cast_details) ? data.cast_details : (Array.isArray(data.cast) ? data.cast : (data.credits?.cast || []));
    
    if (castList.length > 0) {
      castHtml = `
        <table style="width:100%; border-collapse: collapse; margin-top:8px; font-size:13px;">
          <thead>
            <tr style="border-bottom: 1px solid #eee; text-align:left;">
              <th style="padding:6px 4px; font-weight:600; color:#555;">Actor</th>
              <th style="padding:6px 4px; font-weight:600; color:#555; text-align:right;">Character</th>
            </tr>
          </thead>
          <tbody>
            ${castList.slice(0, 10).map(c => {
              const name = typeof c === 'object' ? c.name : c;
              const character = (typeof c === 'object' && c.character) ? c.character : "";
              return `
                <tr style="border-bottom: 1px solid #f9f9f9;">
                  <td style="padding:6px 4px;">
                    <span class="cast-link" data-name="${escapeHtml(name)}" style="font-weight:500; color:#2563eb; cursor:pointer;">${escapeHtml(name)}</span>
                  </td>
                  <td style="padding:6px 4px; color:#666; text-align:right;">${escapeHtml(character)}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      `;
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

        ${data.vote_average ? `
        <div class="sectionTitle">Rating</div>
        <div style="margin-top:8px; display:flex; align-items:center; gap:8px;">
            <span style="font-size:16px; font-weight:600;">⭐ ${data.vote_average.toFixed(1)}</span>
            <span style="color:#666; font-size:13px;">(${data.vote_count || 0} votes)</span>
        </div>
        ` : ''}
        
        ${data.original_language || data.production_countries ? `
        <div style="margin-top:8px; font-size:13px;">
            ${data.original_language ? `<div><strong>Language:</strong> ${escapeHtml(getLanguageName(data.original_language))}</div>` : ''}
            ${data.production_countries && data.production_countries.length > 0 ? `<div style="margin-top:4px;"><strong>Country:</strong> ${escapeHtml(data.production_countries.join(', '))}</div>` : ''}
        </div>
        ` : ''}

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
        <div class="sectionTitle">Select which providers to include</div>
        <div>${providersHtml}</div>
        ` : ''}


      </div>
      
      <div id="similar-movies-container" style="grid-column: 1 / -1; margin-top: 24px; border-top: 1px solid #eee; padding-top: 16px;">
        <h3 class="sectionTitle" style="margin-bottom: 12px;">Similar ${isTVShow ? 'TV Shows' : 'Movies'}</h3>
        <div id="similar-movies-grid" style="display: flex; gap: 12px; overflow-x: auto; padding-bottom: 8px;">
          <div class="subtle">Loading...</div>
        </div>
      </div>
    `;

    loadSimilarMovies(movieId, isTVShow);

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
        addFilter("keyword", keyword, keyword);
        renderChips();
        loadPage(1);
        closeModal();
      });
    });

    // Add click handlers for provider rows (clicking the name/row adds filter)
    // Note: The link itself opens in new tab, but we can make the row clickable or add a button
    // The user asked: "When someone clicks a provider name I would like it to highlight the appropriate logo in the left-hand panel."
    // So let's attach it to the row, but avoid hijacking the link if they click exactly on the link?
    // Actually, let's just make the text clickable if it's not the link, or add a specific action.
    // But the user said "clicks a provider name".
    
    modalBody.querySelectorAll(".provider-row").forEach(row => {
      row.style.cursor = 'pointer';
      row.addEventListener("click", (e) => {
        // If clicked on the anchor tag, let it open the link
        if (e.target.closest('a')) return;

        const providerName = row.dataset.provider;
        
        // Add to selected providers if not already there
        if (!selectedProviders.has(providerName)) {
            selectedProviders.add(providerName);
            
            // Update sidebar UI
            const sidebarItem = document.querySelector(`.providerItem[data-provider="${CSS.escape(providerName)}"]`);
            if (sidebarItem) {
                sidebarItem.classList.add("selected-provider");
                sidebarItem.style.border = "3px solid yellow";
                sidebarItem.style.borderRadius = "8px";
            }
            
            loadPage(1);
            
            // If on mobile, maybe open the sidebar to show the filter was added?
            // Or just let them see the results update behind the modal.
        }
        closeModal();
      });
    });

  } catch (error) {
    console.error("Error loading movie details:", error);
    modalTitle.textContent = "Error";
    modalBody.innerHTML = "<div style='padding:16px;'>Error loading movie details. Please try again.</div>";
  }
}

async function loadSimilarMovies(movieId, isTVShow = false) {
  const container = document.getElementById("similar-movies-grid");
  if (!container) return;
  
  try {
    const data = await astraApi("similar", { id: movieId, limit: 10 });
    if (!data || !data.results || data.results.length === 0) {
      container.innerHTML = `<div class='subtle'>No similar ${isTVShow ? 'TV shows' : 'movies'} found.</div>`;
      return;
    }
    
    container.innerHTML = data.results.map(m => {
      const title = m.name || m.title;
      return `
      <div class="card similar-card" data-movie-id="${m.id}" style="min-width: 100px; width: 100px; cursor: pointer; border:none; box-shadow:none; background:transparent;">
        <img src="${m.poster_path ? 'https://image.tmdb.org/t/p/w154' + m.poster_path : ''}" 
             alt="${escapeHtml(title)}" 
             style="width:100%; border-radius:8px; aspect-ratio: 2/3; object-fit: cover; background: #eee;">
        <div style="font-size:11px; margin-top:4px; line-height:1.2; max-height:2.4em; overflow:hidden; text-align:center;">${escapeHtml(title)}</div>
      </div>
    `}).join("");
    
    container.querySelectorAll(".similar-card").forEach(card => {
      card.addEventListener("click", () => {
        const newId = card.getAttribute("data-movie-id");
        openMovieModal(newId);
      });
    });

  } catch (e) {
    console.error(e);
    container.innerHTML = `<div class='subtle'>Error loading similar ${isTVShow ? 'TV shows' : 'movies'}.</div>`;
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
let autocompleteDataMovies = null;
let autocompleteDataTV = null;
const AUTOCOMPLETE_TYPES = ["movie", "person", "genre"];

async function loadAutocompleteData() {
  try {
    const startTime = performance.now();
    
    // Load movies autocomplete
    const responseMovies = await fetch("/autocomplete.json");
    if (responseMovies.ok) {
      const dataMovies = await responseMovies.json();
      const entriesMovies = Array.isArray(dataMovies) ? dataMovies : (dataMovies.entries || dataMovies);
      autocompleteDataMovies = entriesMovies.map(entry => {
        if (Array.isArray(entry)) {
          const [typeCode, name, movieId] = entry;
          return {
            type: AUTOCOMPLETE_TYPES[typeCode] || "movie",
            name,
            searchName: name.toLowerCase(),
            movieId,
            contentType: 'movie'
          };
        } else {
          const { type, name, searchName, icon, movieId } = entry;
          const obj = {
            type: typeof type === 'number' ? (AUTOCOMPLETE_TYPES[type] || "movie") : (type || "movie"),
            name,
            searchName: searchName || name.toLowerCase(),
            movieId,
            contentType: 'movie'
          };
          if (icon) obj.icon = icon;
          return obj;
        }
      });
      console.log(`[Autocomplete] Loaded ${autocompleteDataMovies.length} movie entries`);
    } else {
      autocompleteDataMovies = [];
    }
    
    // Load TV shows autocomplete
    try {
      const responseTV = await fetch("/autocomplete-tv-fresh.json");
      if (responseTV.ok) {
        const dataTV = await responseTV.json();
        const entriesTV = Array.isArray(dataTV) ? dataTV : (dataTV.entries || dataTV);
        autocompleteDataTV = entriesTV.map(entry => {
          if (Array.isArray(entry)) {
            const [typeCode, name, tvId] = entry;
            return {
              type: AUTOCOMPLETE_TYPES[typeCode] || "movie",
              name,
              searchName: name.toLowerCase(),
              movieId: tvId,
              contentType: 'tv'
            };
          } else {
            const { type, name, searchName, icon, movieId } = entry;
            const obj = {
              type: typeof type === 'number' ? (AUTOCOMPLETE_TYPES[type] || "movie") : (type || "movie"),
              name,
              searchName: searchName || name.toLowerCase(),
              movieId,
              contentType: 'tv'
            };
            if (icon) obj.icon = icon;
            return obj;
          }
        });
        console.log(`[Autocomplete] Loaded ${autocompleteDataTV.length} TV show entries`);
      } else {
        autocompleteDataTV = [];
      }
    } catch (e) {
      console.log(`[Autocomplete] TV autocomplete not available:`, e);
      autocompleteDataTV = [];
    }
    
    console.log(`[Autocomplete] Total load time: ${(performance.now() - startTime).toFixed(0)}ms`);
  } catch (error) {
    console.error("Failed to load autocomplete data:", error);
    autocompleteDataMovies = [];
    autocompleteDataTV = [];
  }
}

function filterAutocomplete(query) {
  if ((!autocompleteDataMovies && !autocompleteDataTV) || query.length < 2) return [];
  
  const startTime = performance.now();
  const qLower = query.toLowerCase();
  console.log(`[Autocomplete] Filtering for query "${query}" (${qLower})`);
  
  // Combine data from selected content types
  let combinedData = [];
  if (searchMode.movies && autocompleteDataMovies) {
    combinedData = combinedData.concat(autocompleteDataMovies);
  }
  if (searchMode.tvshows && autocompleteDataTV) {
    combinedData = combinedData.concat(autocompleteDataTV);
  }
  
  // Filter entries where searchName starts with query (prefix match)
  const results = combinedData
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

    if (e.key === "ArrowDown") {
      if (items.length === 0) return;
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
      updateSelection(items);
    } else if (e.key === "ArrowUp") {
      if (items.length === 0) return;
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      updateSelection(items);
    } else if (e.key === "Enter") {
      if (selectedIndex >= 0 && items.length > 0) {
        e.preventDefault();
        items[selectedIndex].click();
        selectedIndex = -1;
      } else {
        // Freeform search
        const query = searchInput.value.trim();
        if (query) {
          e.preventDefault();
          addFilter("text", query, query);
          searchInput.value = "";
          autocompleteList.innerHTML = "";
          autocompleteList.style.display = "none";
          // If the search bar is in a modal (unlikely but safe to call)
          if (typeof closeModal === 'function') closeModal(); 
        }
      }
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
            // For movies, add as specific movie filter
            addFilter("movie", result.movieId, result.title || result.name);
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

  providersContainer.innerHTML = PROVIDER_CONFIG.map(provider => {
    if (provider.logo) {
      return `<div class="providerItem" data-provider="${escapeHtml(provider.name)}">
        <img src="${escapeHtml(provider.logo)}" alt="${escapeHtml(provider.name)}" 
             onerror="this.style.display='none'; if(this.parentElement) { this.parentElement.innerText='${escapeHtml(provider.name)}'; this.parentElement.style.fontSize='12px'; this.parentElement.style.textAlign='center'; }">
      </div>`;
    } else {
      return `<div class="providerItem" style="font-size: 13px; text-align: center;">${escapeHtml(provider.name)}</div>`;
    }
  }).join("");

  // Add click handlers
  providersContainer.querySelectorAll(".providerItem").forEach(item => {
    item.style.cursor = 'pointer';
    item.addEventListener("click", () => {
      const providerName = item.dataset.provider || item.textContent;
      
      if (selectedProviders.has(providerName)) {
        selectedProviders.delete(providerName);
        item.classList.remove("selected-provider");
        item.style.border = "none";
      } else {
        selectedProviders.add(providerName);
        item.classList.add("selected-provider");
        item.style.border = "3px solid yellow";
        item.style.borderRadius = "8px";
      }
      
      loadPage(1);
    });
  });
}

function setupLanguageModal() {
  const languageButton = document.getElementById('language-button');
  const languageModalOverlay = document.getElementById('languageModalOverlay');
  const languageModalClose = document.getElementById('languageModalClose');
  const languageApply = document.getElementById('languageApply');
  const languageClearAll = document.getElementById('languageClearAll');
  const languageCheckboxesContainer = document.getElementById('language-checkboxes');
  
  if (!languageButton || !languageModalOverlay) return;
  
  // All available languages in a common order
  const allLanguages = [
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Spanish' },
    { code: 'fr', name: 'French' },
    { code: 'de', name: 'German' },
    { code: 'it', name: 'Italian' },
    { code: 'pt', name: 'Portuguese' },
    { code: 'ja', name: 'Japanese' },
    { code: 'ko', name: 'Korean' },
    { code: 'zh', name: 'Chinese' },
    { code: 'hi', name: 'Hindi' },
    { code: 'ru', name: 'Russian' },
    { code: 'ar', name: 'Arabic' },
    { code: 'th', name: 'Thai' },
    { code: 'nl', name: 'Dutch' },
    { code: 'sv', name: 'Swedish' },
    { code: 'tr', name: 'Turkish' },
    { code: 'pl', name: 'Polish' },
    { code: 'da', name: 'Danish' },
    { code: 'fi', name: 'Finnish' },
    { code: 'no', name: 'Norwegian' },
    { code: 'nb', name: 'Norwegian Bokmål' },
    { code: 'af', name: 'Afrikaans' },
    { code: 'am', name: 'Amharic' },
    { code: 'bg', name: 'Bulgarian' },
    { code: 'bn', name: 'Bengali' },
    { code: 'ca', name: 'Catalan' },
    { code: 'cn', name: 'Cantonese' },
    { code: 'cs', name: 'Czech' },
    { code: 'cy', name: 'Welsh' },
    { code: 'dv', name: 'Divehi' },
    { code: 'el', name: 'Greek' },
    { code: 'et', name: 'Estonian' },
    { code: 'eu', name: 'Basque' },
    { code: 'fa', name: 'Persian' },
    { code: 'gl', name: 'Galician' },
    { code: 'gu', name: 'Gujarati' },
    { code: 'he', name: 'Hebrew' },
    { code: 'hr', name: 'Croatian' },
    { code: 'hu', name: 'Hungarian' },
    { code: 'hy', name: 'Armenian' },
    { code: 'id', name: 'Indonesian' },
    { code: 'is', name: 'Icelandic' },
    { code: 'ka', name: 'Georgian' },
    { code: 'kk', name: 'Kazakh' },
    { code: 'ku', name: 'Kurdish' },
    { code: 'lt', name: 'Lithuanian' },
    { code: 'lv', name: 'Latvian' },
    { code: 'ml', name: 'Malayalam' },
    { code: 'ms', name: 'Malay' },
    { code: 'pa', name: 'Punjabi' },
    { code: 'ro', name: 'Romanian' },
    { code: 'sr', name: 'Serbian' },
    { code: 'ta', name: 'Tamil' },
    { code: 'te', name: 'Telugu' },
    { code: 'tl', name: 'Tagalog' },
    { code: 'uk', name: 'Ukrainian' },
    { code: 'ur', name: 'Urdu' },
    { code: 'uz', name: 'Uzbek' },
    { code: 'xx', name: 'Unknown' }
  ];
  
  // Populate checkboxes
  languageCheckboxesContainer.innerHTML = allLanguages.map(lang => `
    <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 8px; border-radius: 6px; transition: background 0.2s;" 
           onmouseover="this.style.background='#f3f4f6'" 
           onmouseout="this.style.background='transparent'">
      <input type="checkbox" value="${lang.code}" data-lang-name="${lang.name}" 
             style="width: 16px; height: 16px; cursor: pointer;">
      <span style="font-size: 14px;">${lang.name}</span>
    </label>
  `).join('');
  
  // Open modal
  languageButton.addEventListener('click', () => {
    // Update checkboxes to reflect current selection
    const currentLanguages = selectedFilters.filter(f => f.type === 'language').map(f => f.value);
    languageCheckboxesContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = currentLanguages.includes(cb.value);
    });
    
    languageModalOverlay.classList.add('open');
    languageModalOverlay.setAttribute('aria-hidden', 'false');
  });
  
  // Close modal
  const closeLanguageModal = () => {
    languageModalOverlay.classList.remove('open');
    languageModalOverlay.setAttribute('aria-hidden', 'true');
  };
  
  if (languageModalClose) {
    languageModalClose.addEventListener('click', closeLanguageModal);
  }
  
  languageModalOverlay.addEventListener('click', (e) => {
    if (e.target === languageModalOverlay) {
      closeLanguageModal();
    }
  });
  
  // Apply selections
  if (languageApply) {
    languageApply.addEventListener('click', () => {
      // Clear existing language filters
      selectedFilters = selectedFilters.filter(f => f.type !== 'language');
      
      // Add checked languages (addFilter will call loadPage)
      const checkedBoxes = languageCheckboxesContainer.querySelectorAll('input[type="checkbox"]:checked');
      checkedBoxes.forEach((cb, index) => {
        const langCode = cb.value;
        const langName = cb.dataset.langName;
        selectedFilters.push({ type: 'language', id: langCode, name: langName });
      });
      
      renderChips();
      updateLanguageLabel();
      loadPage(1);
      closeLanguageModal();
    });
  }
  
  // Clear all
  if (languageClearAll) {
    languageClearAll.addEventListener('click', () => {
      languageCheckboxesContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
      });
    });
  }
}

function updateLanguageLabel() {
  const languageFilters = selectedFilters.filter(f => f.type === "language");
  const languageButtonText = document.getElementById('language-button-text');
  
  if (languageButtonText) {
    if (languageFilters.length === 0) {
      languageButtonText.textContent = 'Select languages...';
    } else {
      const langNames = languageFilters.map(f => f.name).join(', ');
      languageButtonText.textContent = `Languages: ${langNames}`;
    }
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  // Check for TMDB callback
  await handleTmdbCallback();
  
  await updateUI();
  
  const btnLogin = document.getElementById("btn-login");
  const btnLogout = document.getElementById("btn-logout");
  
  if (btnLogin) btnLogin.addEventListener("click", login);
  if (btnLogout) btnLogout.addEventListener("click", logout);

  // Initialize chips and language label (no default filters)
  renderChips();
  updateLanguageLabel();

  loadPage(1);
  setupAutocomplete();
  setupProviders();
  setupLanguageModal();

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

  const btnStream = document.getElementById("btn-stream");
  const btnRentBuy = document.getElementById("btn-rent-buy");
  const btnMovies = document.getElementById("btn-movies");
  const btnTVShows = document.getElementById("btn-tvshows");

  if (btnMovies) {
    btnMovies.addEventListener("click", () => {
      searchMode.movies = !searchMode.movies;
      updateToggleButtons();
      loadPage(1);
    });
  }

  if (btnTVShows) {
    btnTVShows.addEventListener("click", () => {
      searchMode.tvshows = !searchMode.tvshows;
      updateToggleButtons();
      loadPage(1);
    });
  }

  if (btnStream) {
    btnStream.addEventListener("click", () => {
      searchMode.stream = !searchMode.stream;
      // Ensure at least one is selected? Or allow none (which means no provider results)?
      // Let's allow toggling freely.
      updateToggleButtons();
      loadPage(1);
    });
  }

  if (btnRentBuy) {
    btnRentBuy.addEventListener("click", () => {
      searchMode.rentBuy = !searchMode.rentBuy;
      updateToggleButtons();
      loadPage(1);
    });
  }

  function updateToggleButtons() {
    if (btnMovies) {
      if (searchMode.movies) {
        btnMovies.classList.remove("secondary");
        btnMovies.style.background = "#222";
        btnMovies.style.color = "white";
        btnMovies.style.border = "1px solid #222";
      } else {
        btnMovies.classList.add("secondary");
        btnMovies.style.background = "white";
        btnMovies.style.color = "#222";
        btnMovies.style.border = "1px solid #ddd";
      }
    }

    if (btnTVShows) {
      if (searchMode.tvshows) {
        btnTVShows.classList.remove("secondary");
        btnTVShows.style.background = "#222";
        btnTVShows.style.color = "white";
        btnTVShows.style.border = "1px solid #222";
      } else {
        btnTVShows.classList.add("secondary");
        btnTVShows.style.background = "white";
        btnTVShows.style.color = "#222";
        btnTVShows.style.border = "1px solid #ddd";
      }
    }

    if (btnStream) {
      if (searchMode.stream) {
        btnStream.classList.remove("secondary");
        btnStream.style.background = "#222";
        btnStream.style.color = "white";
        btnStream.style.border = "1px solid #222";
      } else {
        btnStream.classList.add("secondary");
        btnStream.style.background = "white";
        btnStream.style.color = "#222";
        btnStream.style.border = "1px solid #222";
      }
    }
    if (btnRentBuy) {
      if (searchMode.rentBuy) {
        btnRentBuy.classList.remove("secondary");
        btnRentBuy.style.background = "#222";
        btnRentBuy.style.color = "white";
        btnRentBuy.style.border = "1px solid #222";
      } else {
        btnRentBuy.classList.add("secondary");
        btnRentBuy.style.background = "white";
        btnRentBuy.style.color = "#222";
        btnRentBuy.style.border = "1px solid #222";
      }
    }
  }

  // Language modal setup
  setupLanguageModal();

  const clearButton = document.getElementById("clear");
  if (clearButton) {
    clearButton.addEventListener("click", () => {
      selectedFilters = [];
      renderChips();
      updateLanguageLabel();
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

// Remove any direct file loading - use the API endpoint instead
async function initAutocomplete(inputElement) {
  let timeout;
  
  inputElement.addEventListener('input', async (e) => {
    clearTimeout(timeout);
    const query = e.target.value.trim();
    
    if (query.length < 2) {
      hideAutocompleteSuggestions();
      return;
    }
    
    timeout = setTimeout(async () => {
      try {
        const response = await fetch(`/.netlify/functions/astra?action=autocomplete&query=${encodeURIComponent(query)}`);
        
        if (!response.ok) {
          console.error(`Autocomplete failed: ${response.status}`);
          return;
        }
        
        const data = await response.json();
        displayAutocompleteSuggestions(data.results || []);
      } catch (error) {
        console.error('Autocomplete error:', error);
        hideAutocompleteSuggestions();
      }
    }, 300);
  });
}

function displayAutocompleteSuggestions(results) {
  // Your UI code to display suggestions
  const container = document.getElementById('autocomplete-results');
  if (!container) return;
  
  if (results.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }
  
  container.innerHTML = results.map(item => {
    const icon = item.icon || '';
    const name = item.title || item.name;
    return `<div class="autocomplete-item" data-type="${item.type}" data-id="${item.id}">
      ${icon} ${name}
    </div>`;
  }).join('');
  
  container.style.display = 'block';
}

function hideAutocompleteSuggestions() {
  const container = document.getElementById('autocomplete-results');
  if (container) {
    container.innerHTML = '';
    container.style.display = 'none';
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.querySelector('#search-input');
  if (searchInput) {
    initAutocomplete(searchInput);
  }
});

