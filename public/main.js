// API Configuration
const TMDB_AUTH_API = "/.netlify/functions/tmdb_auth";
const BGG_AUTH_API = "/.netlify/functions/bgg_auth";
const USER_DATA_API = "/.netlify/functions/user_data";

// Toast notification
function showToast(message) {
  const existingToast = document.querySelector('.toast');
  if (existingToast) existingToast.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3000);
}

// Modal helpers
function openModal() {
  const modalOverlay = document.getElementById("modalOverlay");
  if (modalOverlay) {
    modalOverlay.classList.add("open");
    modalOverlay.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }
}

function closeModal() {
  const modalOverlay = document.getElementById("modalOverlay");
  const modalBody = document.getElementById("modalBody");
  if (modalOverlay) {
    modalOverlay.classList.remove("open");
    modalOverlay.setAttribute("aria-hidden", "true");
    if (modalBody) modalBody.innerHTML = "";
    document.body.style.overflow = "";
  }
}

const spinnerStyle = document.createElement('style');
spinnerStyle.innerHTML = `
@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
.spinner {
  border: 4px solid rgba(0, 0, 0, 0.1);
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border-left-color: #09f;
  animation: spin 1s ease infinite;
}
`;
document.head.appendChild(spinnerStyle);


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

  // BGG UI
  const bggUsername = localStorage.getItem("bgg_username");
  const bggProfile = document.getElementById("bgg-profile");
  const bggUsernameInput = document.getElementById("bgg-username-input");
  const btnBggLogin = document.getElementById("btn-bgg-login");
  const btnBggLogout = document.getElementById("btn-bgg-logout");

  if (bggUsername) {
    if (bggUsernameInput) bggUsernameInput.style.display = "none";
    if (btnBggLogin) btnBggLogin.style.display = "none";
    if (bggProfile) {
      bggProfile.style.display = "block";
      bggProfile.innerHTML = `Connected as <b>${bggUsername}</b>`;
    }
    if (btnBggLogout) btnBggLogout.style.display = "block";
  } else {
    if (bggUsernameInput) bggUsernameInput.style.display = "block";
    if (btnBggLogin) btnBggLogin.style.display = "block";
    if (bggProfile) bggProfile.style.display = "none";
    if (btnBggLogout) btnBggLogout.style.display = "none";
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
      // Clear all user-related data
      localStorage.removeItem("tmdb_session_id");
      localStorage.removeItem("user_id");
      localStorage.removeItem("tmdb_account_id");
      localStorage.removeItem("tmdb_username");
      console.log("[Logout] User data cleared");
      updateUI();
  }
};

const handleTmdbCallback = async () => {
    const params = new URLSearchParams(window.location.search);
    const requestToken = params.get("request_token");
    const approved = params.get("approved");

    if (requestToken && approved === "true") {
        try {
            // Step 1: Create session
            const res = await fetch(`${TMDB_AUTH_API}?action=create_session`, {
                method: "POST",
                body: JSON.stringify({ request_token: requestToken })
            });
            const data = await res.json();

            if (data.success && data.session_id) {
                const sessionId = data.session_id;
                localStorage.setItem("tmdb_session_id", sessionId);

                // Step 2: Get account details
                const accountRes = await fetch(`${TMDB_AUTH_API}?action=get_account&session_id=${sessionId}`);
                const accountData = await accountRes.json();

                if (accountData.id) {
                    // Store user data for intersect_users collection
                    const userId = `tmdb_${accountData.id}`;
                    localStorage.setItem("user_id", userId);
                    localStorage.setItem("tmdb_account_id", String(accountData.id));
                    localStorage.setItem("tmdb_username", accountData.username || accountData.name || "User");

                    console.log(`[Login] User authenticated: ${userId} (${accountData.username})`);
                } else {
                    console.error("Failed to get account details", accountData);
                }

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

// User Data Helper Functions
const getUserData = async (contentType = null) => {
  const userId = localStorage.getItem("user_id");
  const username = localStorage.getItem("tmdb_username");

  if (!userId) {
    console.warn("[getUserData] No user_id found");
    return null;
  }

  let url = `${USER_DATA_API}?action=get_user_data&user_id=${userId}`;
  if (username) {
    url += `&username=${encodeURIComponent(username)}`;
  }
  if (contentType) {
    url += `&content_type=${contentType}`;
  }

  try {
    const response = await fetch(url);
    const data = await response.json();
    return data;
  } catch (e) {
    console.error("[getUserData] Error:", e);
    return null;
  }
};

let currentPage = 1;
let currentGenre = "";
let currentQuery = "";
let totalPages = 0;
let debounceTimer;
let selectedFilters = []; // Array of {type, id, name}
let selectedProviders = new Set();
let searchMode = { stream: true, rentBuy: false, movies: true, tvshows: false, boardgames: false };
let contentMode = 'movies'; // Always start with movies

let userHasSelectedContent = false;

// Settings
let settings = {
  showSimilar: true
};

// Load settings from localStorage
function loadSettings() {
  const saved = localStorage.getItem('appSettings');
  if (saved) {
    try {
      settings = { ...settings, ...JSON.parse(saved) };
    } catch (e) {
      console.error('Error loading settings:', e);
    }
  }
}

// Save settings to localStorage
function saveSettings() {
  localStorage.setItem('appSettings', JSON.stringify(settings));
}

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



// Dynamically loaded autocomplete data
let genreList = [];
let genreSet = new Set();
let movieAutocompleteData = [];
let boardgameAutocompleteData = [];

// Load movie/TV autocomplete.json and extract genres
fetch("/autocomplete.json")
  .then(r => {
      if (!r.ok) throw new Error("Failed to load autocomplete data");
      return r.json();
  })
  .then(data => {
    movieAutocompleteData = data;
    // Support both compact ([type, name, searchName]) and object ({type, name, ...}) formats
    const genres = (Array.isArray(data) ? data : data.entries || data)
      .filter(entry => (Array.isArray(entry) ? entry[0] === 2 : entry.type === "genre" || entry.type === 2))
      .map(entry => Array.isArray(entry) ? entry[1] : entry.name)
      .filter(name => !!name);
    genreSet = new Set(genres);
    genreList = Array.from(genreSet).sort((a, b) => a.localeCompare(b));
  });

// Load board game autocomplete data
fetch("/autocomplete-boardgames.json")
  .then(r => {
      if (!r.ok) throw new Error("Failed to load board game autocomplete data");
      return r.json();
  })
  .then(data => {
    boardgameAutocompleteData = data;
    console.log('[Autocomplete] Loaded', boardgameAutocompleteData.length, 'board games');
  })
  .catch(err => {
    console.warn('[Autocomplete] Could not load board game data:', err);
  });

// ==================== AUTOCOMPLETE FUNCTIONS ====================

let selectedSuggestionIndex = -1;

function showAutocomplete(query) {
  const suggestionsDiv = document.getElementById('suggestions');
  if (!suggestionsDiv) return;

  if (!query || query.length < 2) {
    suggestionsDiv.style.display = 'none';
    return;
  }

  const lowerQuery = query.toLowerCase();
  const data = searchMode.boardgames ? boardgameAutocompleteData : movieAutocompleteData;
  console.log('[showAutocomplete] searchMode.boardgames:', searchMode.boardgames, '| Using dataset:', searchMode.boardgames ? 'boardgames' : 'movies', '| Data length:', data.length);

  // Filter and match
  const matches = data
    .filter(item => {
      const name = item.name || item.title || '';
      return name.toLowerCase().includes(lowerQuery);
    })
    .slice(0, 10); // Limit to 10 results

  if (matches.length === 0) {
    suggestionsDiv.style.display = 'none';
    return;
  }

  suggestionsDiv.innerHTML = matches.map((item, index) => {
    const name = item.name || item.title || '';
    const type = searchMode.boardgames ? 'boardgame' : (item.type || 'movie');
    const typeLabel = type === 'boardgame' ? '🎲 Game' :
                     type === 'person' ? '👤 Person' :
                     type === 'genre' ? '🎭 Genre' :
                     type === 'tv' ? '📺 TV' : '🎬 Movie';

    return `
      <div class="resultItem ${index === selectedSuggestionIndex ? 'selected' : ''}" data-index="${index}" data-id="${item.id || item.movieId}" data-name="${escapeHtml(name)}" data-type="${type}">
        <span>${escapeHtml(name)}</span>
        <span class="suggestionType">${typeLabel}</span>
      </div>
    `;
  }).join('');

  suggestionsDiv.style.display = 'block';

  // Add click handlers
  suggestionsDiv.querySelectorAll('.resultItem').forEach(item => {
    item.addEventListener('click', () => {
      const name = item.dataset.name;
      const id = item.dataset.id;
      const type = item.dataset.type;

      if (type === 'boardgame' || type === 'movie' || type === 'tv') {
        // For movies/TV/boardgames, add as movie_id filter (which will show only that item)
        addFilter('movie_id', id, name);
      } else if (type === 'person') {
        addFilter('person', name, name);
      } else if (type === 'genre') {
        addFilter('genre', name, name);
      }

      document.getElementById('searchInput').value = '';
      suggestionsDiv.style.display = 'none';
    });
  });
}

// Search input event handler
const searchInput = document.getElementById('searchInput');
if (searchInput) {
  searchInput.addEventListener('input', (e) => {
    selectedSuggestionIndex = -1;
    showAutocomplete(e.target.value);
  });

  searchInput.addEventListener('keydown', (e) => {
    const suggestionsDiv = document.getElementById('suggestions');
    if (!suggestionsDiv || suggestionsDiv.style.display === 'none') return;

    const items = suggestionsDiv.querySelectorAll('.resultItem');

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedSuggestionIndex = Math.min(selectedSuggestionIndex + 1, items.length - 1);
      showAutocomplete(searchInput.value);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedSuggestionIndex = Math.max(selectedSuggestionIndex - 1, -1);
      showAutocomplete(searchInput.value);
    } else if (e.key === 'Enter' && selectedSuggestionIndex >= 0) {
      e.preventDefault();
      items[selectedSuggestionIndex]?.click();
    } else if (e.key === 'Escape') {
      suggestionsDiv.style.display = 'none';
      selectedSuggestionIndex = -1;
    }
  });
}

// Hide suggestions when clicking outside
document.addEventListener('click', (e) => {
  const suggestionsDiv = document.getElementById('suggestions');
  const searchInput = document.getElementById('searchInput');
  if (suggestionsDiv && !searchInput?.contains(e.target) && !suggestionsDiv.contains(e.target)) {
    suggestionsDiv.style.display = 'none';
  }
});

// ==================== FILTER/CHIP FUNCTIONS ====================

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
}

window.removeFilter = function(id) {
  selectedFilters = selectedFilters.filter(f => String(f.id) !== String(id));
  renderChips();
  loadPage(1);
};

function addFilter(type, id, name) {
  if (!selectedFilters.some(f => String(f.id) === String(id))) {
    selectedFilters.push({ type, id, name });
    renderChips();
    loadPage(1);
  }
}
window.addFilter = addFilter;

// Add keyword filter from pill click (closes modal and updates grid)
function addKeywordFilter(keyword) {
  closeModal();
  if (!selectedFilters.some(f => f.type === 'keyword' && f.name === keyword)) {
    selectedFilters.push({ type: 'keyword', id: 'kw_' + keyword, name: keyword });
    renderChips();
    loadPage(1);
  }
}
window.addKeywordFilter = addKeywordFilter;

// ==================== END FILTER/CHIP FUNCTIONS ====================

const modalOverlay = document.getElementById("modalOverlay");
const modalTitle = document.getElementById("modalTitle");
const modalSubtitle = document.getElementById("modalSubtitle");
const modalBody = document.getElementById("modalBody");
const modalClose = document.getElementById("modalClose");

// Modal close button listener
if (modalClose) {
  modalClose.addEventListener("click", closeModal);
}

// Close modal when clicking overlay background
if (modalOverlay) {
  modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) {
      closeModal();
    }
  });
}

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

// --- Content Mode Button Logic ---
const btnMovies = document.getElementById("btn-content-movies");
const btnTVShows = document.getElementById("btn-content-tvshows");
const btnBoardGames = document.getElementById("btn-content-boardgames");

function updateContentButtons() {
    console.log('[updateContentButtons] searchMode:', searchMode);
    
    // 1. Sync Logo
    const logoImg = document.getElementById("logo-img");
    if (logoImg) {
        if (searchMode.boardgames) {
            logoImg.src = "/BGG.jpg";
            logoImg.alt = "BoardGameGeek";
        } else {
            logoImg.src = "/themoviedb.jpg";
            logoImg.alt = "The Movie Database";
        }
    }

    // 2. Sync Button Highlights
    const buttons = {
        movies: document.getElementById("btn-content-movies"),
        tvshows: document.getElementById("btn-content-tvshows"),
        boardgames: document.getElementById("btn-content-boardgames")
    };

    if (buttons.movies) {
        buttons.movies.className = (!searchMode.boardgames && searchMode.movies) ? 'button' : 'button secondary';
        // Remove inline styles that might interfere
        buttons.movies.style.background = '';
        buttons.movies.style.borderColor = '';
        buttons.movies.style.color = '';
    }
    if (buttons.tvshows) {
        buttons.tvshows.className = (!searchMode.boardgames && searchMode.tvshows) ? 'button' : 'button secondary';
    }
    if (buttons.boardgames) {
        buttons.boardgames.className = searchMode.boardgames ? 'button' : 'button secondary';
    }

    // 3. Update Search Label and Placeholder
    const searchLabel = document.getElementById('search-label');
    const searchInput = document.getElementById('searchInput');

    if (searchLabel) {
        if (searchMode.boardgames) {
            searchLabel.textContent = 'Search for Game/Publisher/Designer';
        } else {
            searchLabel.textContent = 'Search for Title/Genre/Person';
        }
    }

    if (searchInput) {
        if (searchMode.boardgames) {
            searchInput.placeholder = 'Search games, designers, publishers…';
        } else {
            searchInput.placeholder = 'Search movies, actors, genres…';
        }
    }

    // 4. Render Providers
    const providersSection = document.getElementById('providers');
    const providersLabel = document.getElementById('providers-label');

    if (providersSection && providersLabel) {
        if (searchMode.boardgames) {
            providersSection.style.display = 'none';
            providersLabel.style.display = 'none';
            providersSection.innerHTML = '';
        } else {
            providersSection.style.display = 'grid';
            providersLabel.style.display = 'block';
            
            console.log('[updateContentButtons] rendering providers. config length:', PROVIDER_CONFIG.length);
            
            if (Array.isArray(PROVIDER_CONFIG) && PROVIDER_CONFIG.length > 0) {
                providersSection.innerHTML = PROVIDER_CONFIG.map(p => `
                    <div class="providerItem${selectedProviders.has(p.name) ? ' selected-provider' : ''}" data-provider="${p.name}" title="${p.name}">
                        <img src="${p.logo}" alt="${p.name}" style="height:32px;" />
                    </div>
                `).join('');

                providersSection.querySelectorAll('.providerItem').forEach(item => {
                    item.addEventListener('click', () => {
                        const provider = item.getAttribute('data-provider');
                        if (selectedProviders.has(provider)) {
                            selectedProviders.delete(provider);
                        } else {
                            selectedProviders.add(provider);
                        }
                        updateContentButtons(); // Re-render to show selection
                        loadPage(1);
                    });
                });
            } else {
                providersSection.innerHTML = '<div style="color:#cbd5e1; padding:8px;">No providers configured.</div>';
            }
        }
    } else {
        console.error('[updateContentButtons] Could not find providers elements');
    }
}

if (btnMovies) {
  btnMovies.addEventListener('click', () => {
    searchMode.boardgames = false;
    if (searchMode.movies && searchMode.tvshows) {
      searchMode.movies = false;
    } else {
      searchMode.movies = true;
    }
    if (!searchMode.movies && !searchMode.tvshows) searchMode.movies = true;
    updateContentButtons();
    loadPage(1);
  });
}

if (btnTVShows) {
  btnTVShows.addEventListener('click', () => {
    searchMode.boardgames = false;
    if (searchMode.tvshows && searchMode.movies) {
      searchMode.tvshows = false;
    } else {
      searchMode.tvshows = true;
    }
    if (!searchMode.movies && !searchMode.tvshows) searchMode.tvshows = true;
    updateContentButtons();
    loadPage(1);
  });
}

if (btnBoardGames) {
  btnBoardGames.addEventListener('click', () => {
    if (searchMode.boardgames) {
        searchMode.boardgames = false;
        searchMode.movies = true;
        searchMode.tvshows = false;
    } else {
        searchMode.movies = false;
        searchMode.tvshows = false;
        searchMode.boardgames = true;
    }
    updateContentButtons();
    loadPage(1);
  });
}

// Login/Logout button handlers
const btnLogin = document.getElementById('btn-login');
const btnLogout = document.getElementById('btn-logout');

if (btnLogin) {
  btnLogin.addEventListener('click', login);
}

if (btnLogout) {
  btnLogout.addEventListener('click', logout);
}

// BGG Login/Logout button handlers
const btnBggLogin = document.getElementById('btn-bgg-login');
const btnBggLogout = document.getElementById('btn-bgg-logout');

if (btnBggLogin) {
  btnBggLogin.addEventListener('click', async () => {
    const usernameInput = document.getElementById('bgg-username-input');
    const username = usernameInput?.value.trim();

    if (!username) {
      showToast('Please enter a BGG username');
      return;
    }

    try {
      // Verify username exists
      const response = await fetch(`${BGG_AUTH_API}?action=get_user&username=${encodeURIComponent(username)}`);
      const user = await response.json();

      if (response.status === 404 || user.error) {
        showToast('BGG user not found');
        return;
      }

      localStorage.setItem('bgg_username', username);
      updateUI();
      showToast(`Connected to BGG as ${username}`);
    } catch (e) {
      console.error('BGG login error:', e);
      showToast('Error connecting to BGG');
    }
  });
}

if (btnBggLogout) {
  btnBggLogout.addEventListener('click', () => {
    localStorage.removeItem('bgg_username');
    updateUI();
    showToast('Disconnected from BGG');
  });
}

async function astraApi(action, params = {}) {
  try {
    const url = new URL("/.netlify/functions/astra", window.location.origin);
    url.searchParams.set("action", action);
    
    // Add settings to API calls
    if (settings.showSimilar !== undefined) {
      url.searchParams.set("show_similar", settings.showSimilar ? "true" : "false");
    }
    
    // Add content_mode for relevant actions
    if (action === "details" || action === "similar" || action === "similar_boardgames") {
      url.searchParams.set("content_mode", contentMode);
    }
    
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    console.log(`[astraApi] Sending request: action=${action}, full URL=${url.toString()}, params=`, params);

    const response = await fetch(url.toString());
    console.log(`[astraApi] Response status: ${response.status}, headers:`, Object.fromEntries(response.headers.entries()));

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[astraApi] HTTP error: ${response.status}, response text:`, errorText);
      throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
    }

    const data = await response.json();
    console.log(`[astraApi] Received data:`, data);
    return data;
  } catch (error) {
    console.error("[astraApi] Error:", error);
    throw error;
  }
}

function getGenreName(genreData) {
  if (!genreData || genreData.length === 0) return "Unknown";
  // If genreData is array of objects with .name
  if (typeof genreData[0] === 'object') {
    return genreData.map(g => g.name || "Unknown").join(", ");
  }
  // If genreData is
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

// Store the current movies array globally so click handlers can access it
let currentMoviesData = [];

function renderGrid(movies) {
  const output = document.getElementById("output");
  if (!output) {
    btnBoardGames.className = 'button';
    return;
  }

  // Always clear output before rendering
  output.innerHTML = "";

  if (!Array.isArray(movies) || movies.length === 0) {
    if (selectedProviders.size > 0) {
      const providersList = Array.from(selectedProviders).join(", ");
      output.textContent = `No results from selected providers (${providersList})`;
    } else {
      output.textContent = "No results.";
    }
    return;
  }

  currentMoviesData = movies;

  const isBoardGame = searchMode.boardgames;

  // Exclude board games if BOTH image and thumbnail are missing or empty
  let filteredMovies = movies;
  if (isBoardGame) {
    filteredMovies = movies.filter(
      m =>
        (typeof m.image === 'string' && m.image.trim() !== '') ||
        (typeof m.thumbnail === 'string' && m.thumbnail.trim() !== '')
    );
  }

  // If filteredMovies is empty, show "No results"
  if (!Array.isArray(filteredMovies) || filteredMovies.length === 0) {
    output.textContent = "No results.";
    return;
  }

  output.innerHTML = `
    <div class="grid">
      ${filteredMovies.slice(0, 20).map((m, index) => {
        if (isBoardGame) {
          const title = m.name0 || m.name || m.title || "Unknown Game";
          const year = m.year ? Math.floor(m.year) : 0;
          const rating = m.average || m.bayesaverage || 0;
          const usersRated = m.usersrated ? Math.floor(m.usersrated) : null;
          const minPlayers = m.minplayers ? Math.floor(m.minplayers) : null;
          const maxPlayers = m.maxplayers ? Math.floor(m.maxplayers) : null;
          const players = (minPlayers && maxPlayers) ? `${minPlayers}-${maxPlayers} players` : "";
          const thumbnail = m.image || m.thumbnail || null;
          const itemId = m.bggid || m.bgg_id;

          // --- FIX: Always show usersRated if present ---
          let ratingHtml = "";
          if (rating) {
            ratingHtml = ` • ⭐ ${rating.toFixed(1)}`;
            if (usersRated !== null) {
              ratingHtml += ` (${usersRated.toLocaleString()} ratings)`;
            }
          }

          return `
            <div class="card" data-index="${index}" data-content-type="boardgame" data-id="${itemId}">
              ${thumbnail 
                ? `<img src="${escapeHtml(thumbnail)}" alt="${escapeHtml(title)}" style="width:100%; aspect-ratio: 1; object-fit: cover;" onerror="this.closest('.card').style.display='none';" />` 
                : `<div class="noposter" style="aspect-ratio: 1; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center; color: white; font-size: 48px; border-radius: 8px;">\n     🎲\n   </div>`
              }
              <div class="movieTitle" style="margin-top: 8px;">${escapeHtml(title)}</div>
              <div class="meta" style="font-size: 12px; color: #666;">\n        Year: ${year !== undefined ? year : "0"}\n        ${ratingHtml}\n        ${players ? `<br>👥 ${players}` : ""}\n      </div>
            </div>
          `;
        } else {
          // ...existing code for movies/tv...
          const title = m.name || m.title;
          const releaseDate = m.first_air_date || m.release_date;
          const contentType = m.content_type || 'movie';
          return `
            <div class="card" data-index="${index}" data-content-type="${contentType}">
              ${m.poster_path
                ? `<img src="https://image.tmdb.org/t/p/w500${m.poster_path}" alt="${escapeHtml(title)}" />`
                : `<div class="noposter">No poster</div>`
              }
              <div class="movieTitle">${escapeHtml(title)}</div>
              <div class="meta">
                ${releaseDate ? `Released ${new Date(releaseDate).getFullYear()}` : ""}
                ${m.vote_average ? ` • ⭐ ${m.vote_average.toFixed(1)}` : ""}
              </div>
            </div>
          `;
        }
      }).join("")}
    </div>
  `;

  // --- FIX: Use event delegation for .card clicks to ensure modal opens for all cards, including boardgames ---
  const grid = output.querySelector('.grid');
  if (grid) {
    grid.addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      const index = parseInt(card.getAttribute('data-index'));
      const item = currentMoviesData[index];
      if (item) {
        if (searchMode.boardgames) {
          const itemId = item.bggid || item.bgg_id;
          openMovieModal(itemId, 'boardgame');
        } else {
          const itemId = item.id || item._id;
          const contentType = item.content_type === 'tvshow' || item.content_type === 'tv' ? 'tvshow' : 'movie';
          openMovieModal(itemId, contentType);
        }
      }
    });
  }
}

function renderPagination(page, total) {
  // Pagination disabled
}

async function loadPage(page = 1) {
  console.log('[LoadPage] ===== LOADPAGE CALLED =====');
  console.log('[LoadPage] contentMode:', contentMode);
  console.log('[LoadPage] selectedFilters:', selectedFilters);
  console.log('[LoadPage] selectedProviders:', Array.from(selectedProviders));

  currentPage = 1;
  const output = document.getElementById("output");
  if (output) {
    output.innerHTML = `<div style="display:flex; justify-content:center; padding:50px;"><div class="spinner"></div></div>`;
  }

  try {
    let results = [];
    let data;

    // --- FIX: Only one of boardgames or (movies/tvshows) can be enabled ---
    if (searchMode.boardgames) {
      const params = { sort: "usersrated", sort_order: "desc", content_types: "boardgames" };
      const dataBG = await astraApi("discover", params);
      results = (dataBG && dataBG.results) ? dataBG.results.filter(game => game.year) : [];
      renderGrid(results);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    // Movies and/or TV Shows (can be both)
    let movieResults = [];
    let tvResults = [];
    // Movies
    if (searchMode.movies) {
      const params = { sort: "popularity", sort_order: "desc", content_types: "movies" };
      const dataMovies = await astraApi("discover", params);
      if (dataMovies && dataMovies.results) movieResults = dataMovies.results;
    }
    // TV Shows
    if (searchMode.tvshows) {
      const params = { sort: "popularity", sort_order: "desc", content_types: "tvshows" };
      const dataTV = await astraApi("discover", params);
      if (dataTV && dataTV.results) tvResults = dataTV.results;
    }
    results = [...movieResults, ...tvResults];
    // Sort by popularity (descending), fallback to 0 if missing
    results.sort((a, b) => {
      const aPop = a.popularity ? Number(a.popularity) : 0;
      const bPop = b.popularity ? Number(b.popularity) : 0;
      return bPop - aPop;
    });
    renderGrid(results);
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    console.error("Error loading page:", error);
    const output = document.getElementById("output");
    if (output) {
      output.textContent = "Error loading content. Please try again.";
    }
  }
}

async function openMovieModal(movieId, contentType = 'movie') {
  openModal();
  modalTitle.textContent = "Loading…";
  modalSubtitle.textContent = "";
  modalBody.innerHTML = "";

  try {
    console.log('[OpenModal] Fetching details for:', movieId, 'contentType:', contentType);
    let data;
    if (contentType === 'boardgame') {
      data = await astraApi("details", { id: movieId, type: 'boardgame' });
    } else if (contentType === 'tvshow' || contentType === 'tv') {
      data = await astraApi("details", { id: movieId, type: 'tvshow' });
    } else {
      data = await astraApi("details", { id: movieId, type: 'movie' });
    }
    console.log('[OpenModal] Received data:', data);

    // Always use data.results[0] as the movie object
    let movie = null;
    if (data && Array.isArray(data.results) && data.results.length > 0) {
      movie = data.results[0];
    } else if (data && data.results && typeof data.results === 'object' && Object.keys(data.results).length > 0) {
      movie = data.results;
    } else if (data && !data.results && Object.keys(data).length > 0) {
      movie = data;
    }

    if (!movie || Object.keys(movie).length === 0) {
      modalTitle.textContent = "Content not found";
      modalBody.innerHTML = "<div style='padding:16px;'>Content not found.</div>";
      return;
    }

    const isBoardGame = contentType === 'boardgame' || movie.name0 !== undefined || movie.bggid !== undefined;

    if (isBoardGame) {
      console.log('[BoardGame Modal] Full movie object:', movie);
      console.log('[BoardGame Modal] Keys:', Object.keys(movie));
      console.log('[BoardGame Modal] Raw categories:', movie.categories, 'type:', typeof movie.categories);
      console.log('[BoardGame Modal] Raw mechanics:', movie.mechanics, 'type:', typeof movie.mechanics);
      console.log('[BoardGame Modal] Raw designers:', movie.designers, 'type:', typeof movie.designers);
      console.log('[BoardGame Modal] Raw publishers:', movie.publishers, 'type:', typeof movie.publishers);
      
      modalTitle.textContent = movie.name0 || movie.name || movie.title || "Unknown Game";
      
      const year = movie.year ? Math.floor(movie.year) : 0;
      const rating = movie.average || movie.bayesaverage;
      const usersRated = movie.usersrated ? Math.floor(movie.usersrated) : null;
      
      const subtitleParts = [
        year !== undefined ? year : null,
        rating ? `⭐ ${rating.toFixed(2)}` : null,
        usersRated ? `${usersRated.toLocaleString()} ratings` : null
      ].filter(x => x != null).join(" • ");
      
      modalSubtitle.textContent = subtitleParts;

      const minPlayers = movie.minplayers ? Math.floor(movie.minplayers) : null;
      const maxPlayers = movie.maxplayers ? Math.floor(movie.maxplayers) : null;
      const playingTime = movie.playingtime ? Math.floor(movie.playingtime) : null;
      const minPlayTime = movie.minplaytime ? Math.floor(movie.minplaytime) : null;
      const maxPlayTime = movie.maxplaytime ? Math.floor(movie.maxplaytime) : null;
      const minAge = movie.minage ? Math.floor(movie.minage) : null;
      const rank = movie.boardgamerank ? Math.floor(movie.boardgamerank) : null;
      const usersRatedCount = movie.usersrated ? Math.floor(movie.usersrated) : null;

      const gameDetailsHtml = `
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 16px; padding: 12px; background: #f8f9fa; border-radius: 8px;">
          ${(minPlayers || maxPlayers) ? `
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="font-size: 20px;">👥</span>
              <div>
                <div style="font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.5px;">Players</div>
                <div style="font-weight: 600; color: #222; font-size: 13px;">${minPlayers || '?'}-${maxPlayers || '?'}</div>
              </div>
            </div>
          ` : ''}
          ${(playingTime || minPlayTime || maxPlayTime) ? `
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="font-size: 20px;">⏱️</span>
              <div>
                <div style="font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.5px;">Play Time</div>
                <div style="font-weight: 600; color: #222; font-size: 13px;">
                  ${minPlayTime && maxPlayTime ? `${minPlayTime}-${maxPlayTime} min` : `${playingTime || '?'} min`}
                </div>
              </div>
            </div>
          ` : ''}
          ${minAge ? `
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="font-size: 20px;">🎂</span>
              <div>
                <div style="font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.5px;">Age</div>
                <div style="font-weight: 600; color: #222; font-size: 13px;">${minAge}+</div>
              </div>
            </div>
          ` : ''}
          ${rank ? `
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="font-size: 20px;">🏆</span>
              <div>
                <div style="font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.5px;">BGG Rank</div>
                <div style="font-weight: 600; color: #222; font-size: 13px;">#${rank.toLocaleString()}</div>
              </div>
            </div>
          ` : ''}
          ${movie.weight ? `
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="font-size: 20px;">🎓</span>
              <div>
                <div style="font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.5px;">Complexity</div>
                <div style="font-weight: 600; color: #222; font-size: 13px;">${movie.weight.toFixed(2)} / 5</div>
              </div>
            </div>
          ` : ''}
          ${rating ? `
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="font-size: 20px;">⭐</span>
              <div>
                <div style="font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.5px;">Rating</div>
                <div style="font-weight: 600; color: #222; font-size: 13px;">${rating.toFixed(2)} / 10</div>
              </div>
            </div>
          ` : ''}
        </div>
      `;

      // Handle both array format and comma-separated string format
      let publishers = [];
      console.log('[DEBUG] movie.publishers value:', movie.publishers, '| isArray:', Array.isArray(movie.publishers), '| typeof:', typeof movie.publishers);
      if (Array.isArray(movie.publishers)) {
        publishers = movie.publishers;
      } else if (typeof movie.publishers === 'string' && movie.publishers.trim()) {
        publishers = movie.publishers.split(',').map(s => s.trim()).filter(Boolean);
        console.log('[DEBUG] Split publishers into:', publishers);
      } else {
        for (let i = 0; i < 10; i++) {
          if (movie[`publisher${i}`]) publishers.push(movie[`publisher${i}`]);
        }
      }
      console.log('[BoardGame Modal] Publishers found:', publishers);
      
      const publishersHtml = publishers.length > 0 ? `
        <div class="sectionTitle" style="margin-top: 8px;">Publishers</div>
        <div class="pillRow" style="margin-top: 4px;">
          ${publishers.map(p => `<span class="pill publisher-pill" onclick="addKeywordFilter('${escapeHtml(p).replace(/'/g, "\\'")}'" style="cursor: pointer; background: #e3f2fd; color: #1976d2; border: 1px solid #bbdefb;">${escapeHtml(p)}</span>`).join("")}
        </div>
      ` : '';

      let categories = [];
      if (Array.isArray(movie.categories)) {
        categories = movie.categories;
      } else if (typeof movie.categories === 'string' && movie.categories.trim()) {
        categories = movie.categories.split(',').map(s => s.trim()).filter(Boolean);
      } else if (Array.isArray(movie.boardgamecategory)) {
        categories = movie.boardgamecategory;
      } else {
        for (let i = 0; i < 10; i++) {
          if (movie[`category${i}`]) categories.push(movie[`category${i}`]);
        }
      }
      console.log('[BoardGame Modal] Categories found:', categories);
      
      const categoriesHtml = categories.length > 0 ? `
        <div class="sectionTitle" style="margin-top: 8px;">Categories</div>
        <div class="pillRow" style="margin-top: 4px;">
          ${categories.map(c => `<span class="pill category-pill" onclick="addKeywordFilter('${escapeHtml(c).replace(/'/g, "\\'")}'" style="cursor: pointer; background: #f3e5f5; color: #7b1fa2; border: 1px solid #e1bee7;">${escapeHtml(c)}</span>`).join("")}
        </div>
      ` : '';

      let mechanics = [];
      if (Array.isArray(movie.mechanics)) {
        mechanics = movie.mechanics;
      } else if (typeof movie.mechanics === 'string' && movie.mechanics.trim()) {
        mechanics = movie.mechanics.split(',').map(s => s.trim()).filter(Boolean);
      } else if (Array.isArray(movie.boardgamemechanic)) {
        mechanics = movie.boardgamemechanic;
      } else {
        for (let i = 0; i < 10; i++) {
          if (movie[`mechanic${i}`]) mechanics.push(movie[`mechanic${i}`]);
        }
      }
      console.log('[BoardGame Modal] Mechanics found:', mechanics);
      
      const mechanicsHtml = mechanics.length > 0 ? `
        <div class="sectionTitle" style="margin-top: 8px;">Mechanics</div>
        <div class="pillRow" style="margin-top: 4px;">
          ${mechanics.map(m => `<span class="pill mechanic-pill" onclick="addKeywordFilter('${escapeHtml(m).replace(/'/g, "\\'")}'" style="cursor: pointer; background: #e8f5e9; color: #388e3c; border: 1px solid #c8e6c9;">${escapeHtml(m)}</span>`).join("")}
        </div>
      ` : '';

      // Handle designers and artists arrays (or comma-separated strings)
      let designers = [];
      if (Array.isArray(movie.designers)) {
        designers = movie.designers;
      } else if (typeof movie.designers === 'string' && movie.designers.trim()) {
        designers = movie.designers.split(',').map(s => s.trim()).filter(Boolean);
      } else {
        for (let i = 0; i < 10; i++) {
          if (movie[`designer${i}`]) designers.push(movie[`designer${i}`]);
        }
      }
      const designersHtml = designers.length > 0 ? `
        <div class="sectionTitle" style="margin-top: 8px;">Designers</div>
        <div class="pillRow" style="margin-top: 4px;">
          ${designers.map(d => `<span class="pill designer-pill" onclick="addKeywordFilter('${escapeHtml(d).replace(/'/g, "\\'")}'" style="cursor: pointer; background: #fff3e0; color: #e65100; border: 1px solid #ffe0b2;">${escapeHtml(d)}</span>`).join("")}
        </div>
      ` : '';

      let artists = [];
      if (Array.isArray(movie.artists)) {
        artists = movie.artists;
      } else if (typeof movie.artists === 'string' && movie.artists.trim()) {
        artists = movie.artists.split(',').map(s => s.trim()).filter(Boolean);
      } else {
        for (let i = 0; i < 10; i++) {
          if (movie[`artist${i}`]) artists.push(movie[`artist${i}`]);
        }
      }
      const artistsHtml = artists.length > 0 ? `
        <div class="sectionTitle" style="margin-top: 8px;">Artists</div>
        <div class="pillRow" style="margin-top: 4px;">
          ${artists.map(a => `<span class="pill artist-pill" onclick="addKeywordFilter('${escapeHtml(a).replace(/'/g, "\\'")}'" style="cursor: pointer; background: #fce4ec; color: #c2185b; border: 1px solid #f8bbd9;">${escapeHtml(a)}</span>`).join("")}
        </div>
      ` : '';

      const owned = movie.owned ? Math.floor(movie.owned) : null;
      const trading = movie.trading ? Math.floor(movie.trading) : null;
      const wanting = movie.wanting ? Math.floor(movie.wanting) : null;
      const wishing = movie.wishing ? Math.floor(movie.wishing) : null;

      const communityStatsHtml = (owned || trading || wanting || wishing) ? `
        <div class="sectionTitle" style="margin-top: 8px;">Community</div>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 8px; padding: 12px; background: #fafafa; border-radius: 8px;">
          ${owned ? `
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="font-size: 18px;">👥</span>
              <div>
                <div style="font-size: 10px; color: #666;">Owned</div>
                <div style="font-weight: 600; font-size: 13px;">${owned.toLocaleString()}</div>
              </div>
            </div>
          ` : ''}
          ${trading ? `
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="font-size: 18px;">🔄</span>
              <div>
                <div style="font-size: 10px, color: #666;">Trading</div>
                <div style="font-weight: 600; font-size: 13px;">${trading.toLocaleString()}</div>
              </div>
            </div>
          ` : ''}
          ${wanting ? `
                <div style="font-size: 10px, color: #666;">Trading</div>
                <div style="font-weight: 600; font-size: 13px;">${trading.toLocaleString()}</div>
              </div>
            </div>
          ` : ''}
          ${wanting ? `
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="font-size: 18px;">🎯</span>
              <div>
                <div style="font-size: 10px, color: #666;">Wanting</div>
                <div style="font-weight: 600; font-size: 13px;">${wanting.toLocaleString()}</div>
              </div>
            </div>
          ` : ''}
          ${wishing ? `
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="font-size: 18px;">⭐</span>
              <div>
                <div style="font-size: 10px, color: #666;">Wishlisted</div>
                <div style="font-weight: 600; font-size: 13px;">${wishing.toLocaleString()}</div>
              </div>
            </div>
          ` : ''}
        </div>
      ` : '';
      
      const bggId = movie.id || movie.bgg_id;
      const bggLinkHtml = bggId ? `
        <div style="margin-top: 24px;">
          <a href="https://boardgamegeek.com/boardgame/${bggId}" target="_blank" rel="noopener noreferrer" 
             style="display: inline-flex; align-items: center; gap: 8px; padding: 12px 20px; background: #ff5722; color: white; text-decoration: none; border-radius: 8px; font-weight: 600; transition: background 0.2s;"
             onmouseover="this.style.background='#e64a19'" onmouseout="this.style.background='#ff5722'">
            <span style="font-size: 20px;">🎲</span>
            View on BoardGameGeek
          </a>
        </div>
      ` : '';
      
      // Prefer image over thumbnail for modal display
      const modalImage = movie.image || movie.thumbnail || null;
      const description = movie.description || "No description available.";

      // Create a temporary div to safely parse HTML and convert to readable text
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = description;
      
      // Replace <br/> and <br> tags with actual line breaks
      tempDiv.innerHTML = tempDiv.innerHTML.replace(/<br\s*\/?>/gi, '\n');
      
      // Get the text content (this automatically strips tags and decodes HTML entities)
      const cleanDescription = tempDiv.textContent || tempDiv.innerText || "No description available.";

      console.log('[BoardGame Modal] HTML sections:');
      console.log('  designersHtml:', designersHtml ? 'YES' : 'EMPTY');
      console.log('  publishersHtml:', publishersHtml ? 'YES' : 'EMPTY');
      console.log('  categoriesHtml:', categoriesHtml ? 'YES' : 'EMPTY');
      console.log('  mechanicsHtml:', mechanicsHtml ? 'YES' : 'EMPTY');

      modalBody.innerHTML = `
        <div class="poster">
          ${modalImage
            ? `<img src="${escapeHtml(modalImage)}" alt="${escapeHtml(movie.name || movie.title || "")}" style="width:100%; aspect-ratio: 1; object-fit: cover; border-radius:8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />`
            : `<div class="noposter" style="aspect-ratio: 1; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center; color: white; font-size: 48px; border-radius: 8px;">
                 🎲
               </div>`
          }
          ${bggLinkHtml}
        </div>
        <div style="background: white; padding: 16px; border-radius: 8px;">
          <div id="user-rating-section"></div>

          ${gameDetailsHtml}

          <div class="sectionTitle" style="margin-top: 16px; margin-bottom: 8px;">Description</div>
          <div class="overview" style="line-height: 1.6; color: #333; background: #f9fafb; padding: 12px; border-radius: 8px; border-left: 4px solid #667eea; white-space: pre-line; font-size: 13px;">${escapeHtml(cleanDescription)}</div>
          ${categoriesHtml}
          ${mechanicsHtml}
          ${designersHtml}
          ${artistsHtml}
          ${publishersHtml}
          ${communityStatsHtml}
        </div>

        <div id="similar-boardgames-container" style="grid-column: 1 / -1; margin-top: 20px; border-top: 2px solid #eee; padding-top: 16px;">
          <h3 class="sectionTitle" style="margin-bottom: 12px; font-size: 16px;">Similar Board Games</h3>
          <div id="similar-boardgames-grid" style="display: flex; gap: 12px; overflow-x: auto; padding-bottom: 8px;">
            <div class="subtle">Loading...</div>
          </div>
        </div>
      `;
      
      // Debug: log the actual HTML to see if pills are there
      console.log('[BoardGame Modal] Pills in DOM:', {
        publishers: modalBody.querySelectorAll('.publisher-pill').length,
        categories: modalBody.querySelectorAll('.category-pill').length,
        mechanics: modalBody.querySelectorAll('.mechanic-pill').length,
        designers: modalBody.querySelectorAll('.designer-pill').length
      });

      modalBody.querySelectorAll(".publisher-pill").forEach(pill => {
        pill.addEventListener("click", () => {
          const publisher = pill.textContent;
          addFilter("text", publisher, publisher);
          renderChips();
          loadPage(1);
          closeModal();
        });
      });

      modalBody.querySelectorAll(".category-pill").forEach(pill => {
        pill.addEventListener("click", () => {
          const category = pill.textContent;
          addFilter("text", category, category);
          renderChips();
          loadPage(1);
          closeModal();
        });
      });

      modalBody.querySelectorAll(".mechanic-pill").forEach(pill => {
        pill.addEventListener("click", () => {
          const mechanic = pill.textContent;
          addFilter("text", mechanic, mechanic);
          renderChips();
          loadPage(1);
          closeModal();
        });
      });

      modalBody.querySelectorAll(".designer-pill").forEach(pill => {
        pill.addEventListener("click", () => {
          const designer = pill.textContent;
          addFilter("person", designer, designer);
          renderChips();
          loadPage(1);
          closeModal();
        });
      });

      modalBody.querySelectorAll(".artist-pill").forEach(pill => {
        pill.addEventListener("click", () => {
          const artist = pill.textContent;
          addFilter("person", artist, artist);
          renderChips();
          loadPage(1);
          closeModal();
        });
      });

      loadSimilarBoardGames(movieId);
      loadUserSection(movieId, false, true); // movieId, isTVShow=false, isBoardGame=true

      return;
    }

    // For movies/TV: always use movie.name or movie.title directly
    const isTVShow = movie.content_type === 'tv';

    modalTitle.textContent = movie.name || movie.title || (isTVShow ? "TV Show" : "Movie");

    const subtitleParts = [
      movie.first_air_date || movie.release_date ? new Date(movie.first_air_date || movie.release_date).getFullYear() : "",
      isTVShow && movie.number_of_seasons ? `${movie.number_of_seasons} Season${movie.number_of_seasons > 1 ? 's' : ''}` : "",
      !isTVShow && movie.runtime ? `${movie.runtime} min` : "",
      movie.vote_average ? `⭐ ${movie.vote_average.toFixed(1)} (${movie.vote_count || 0} votes)` : "",
      movie.popularity ? `📈 ${Math.round(movie.popularity)}` : ""
    ].filter(Boolean).join(" • ");

    modalSubtitle.textContent = subtitleParts;

    const posterHtml = movie.poster_path
      ? `<img src="https://image.tmdb.org/t/p/w500${movie.poster_path}" alt="${escapeHtml(movie.name || movie.title || "")}" />`
      : `<div class="noposter" style="height:320px;">No poster</div>`;

    const validId = movie.id || movieId;
    const tmdbUrl = `https://www.themoviedb.org/${isTVShow ? 'tv' : 'movie'}/${validId}`;

    const tmdbLinkHtml = `
      <div style="margin-top: 24px; text-align: left;">
        <a href="${tmdbUrl}" target="_blank" rel="noopener noreferrer" style="text-decoration: none; color: #666; font-size: 11px; display: inline-flex; flex-direction: column; align-items: flex-start; gap: 4px;">
          <span style="text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; color: #888;">View on</span>
          <img src="/themoviedb.jpg" alt="TMDB" style="width: 50px; height: auto; border-radius: 0; box-shadow: none; aspect-ratio: auto; object-fit: contain;">
        </a>
      </div>
    `;

    let spokenLanguagesStr = "";
    if (movie.spoken_languages && Array.isArray(movie.spoken_languages)) {
      spokenLanguagesStr = movie.spoken_languages
        .map(l => l.english_name || l.name)
        .filter(Boolean)
        .join(", ");
    }    

    let genresHtml = "";
    if (Array.isArray(movie.genres)) {
      genresHtml = movie.genres.map(g => 
        typeof g === 'object' ? `<span class="pill genre-pill">${escapeHtml(g.name)}</span>` : `<span class="pill genre-pill">${escapeHtml(g)}</span>`
      ).join("");
    }

    let providersHtml = "";
    if (movie.watch_providers && movie.watch_providers.US) {
      const us = movie.watch_providers.US;
      const providerMap = {};
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
              <tr style="border-bottom: 1px solid #475569; text-align:left;">
                <th style="padding:8px 4px; font-weight:600; color:#cbd5e1;">Provider</th>
                <th style="padding:8px 4px; font-weight:600; color:#cbd5e1;">Availability</th>
              </tr>
            </thead>
            <tbody>
              ${Object.entries(providerMap).map(([name, types]) => {
                const logo = getProviderLogo(name);
                const url = getProviderUrl(name);
                const typeList = Array.from(types).sort().join(', ');
                return `
                  <tr class="provider-row" data-provider="${escapeHtml(name)}" style="border-bottom: 1px solid #334155;">
                    <td style="padding:8px 4px;">
                      <a href="${url}" target="_blank" rel="noopener noreferrer" style="display:flex; align-items:center; gap:8px; text-decoration:none; color:#e2e8f0;">
                        ${logo ? `<img src="${logo}" alt="${escapeHtml(name)}" style="width:24px; height:24px; object-fit:contain; border-radius:4px;">` : ''}
                        <span style="font-weight:500;">${escapeHtml(name)}</span>
                      </a>
                    </td>
                    <td style="padding:8px 4px; color:#94a3b8;">${typeList}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        `;
      }
    }

    let castHtml = "";
    const castList = Array.isArray(movie.cast_details) ? movie.cast_details : (Array.isArray(movie.cast) ? movie.cast : (movie.credits?.cast || []));
    
    if (castList.length > 0) {
      castHtml = `
        <table style="width:100%; border-collapse: collapse; margin-top:8px; font-size:13px;">
          <thead>
            <tr style="border-bottom: 1px solid #475569; text-align:left;">
              <th style="padding:6px 4px; font-weight:600; color:#cbd5e1;">Actor</th>
              <th style="padding:6px 4px; font-weight:600; color:#cbd5e1; text-align:right;">Character</th>
            </tr>
          </thead>
          <tbody>
            ${castList.slice(0, 10).map(c => {
              const name = typeof c === 'object' ? c.name : c;
              const character = (typeof c === 'object' && c.character) ? c.character : "";
              return `
                <tr style="border-bottom: 1px solid #334155;">
                  <td style="padding:6px 4px;">
                    <span class="cast-link" data-name="${escapeHtml(name)}" style="font-weight:500; color:#60a5fa; cursor:pointer;">${escapeHtml(name)}</span>
                  </td>
                  <td style="padding:6px 4px; color:#94a3b8; text-align:right;">${escapeHtml(character)}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      `;
    }

    let keywordsHtml = "";
    if (Array.isArray(movie.keywords)) {
      keywordsHtml = movie.keywords.slice(0, 12).map(k => 
        typeof k === 'object' ? `<span class="pill keyword-pill">${escapeHtml(k.name)}</span>` : `<span class="pill keyword-pill">${escapeHtml(k)}</span>`
      ).join("");
    }

    modalBody.innerHTML = `
      <div class="poster">
        ${posterHtml}
        ${tmdbLinkHtml}
      </div>
      <div>
        ${movie.vote_average ? `
        <div class="sectionTitle" style="margin-top: 0;">Rating</div>
        <div style="margin-top:8px; display:flex; align-items:center; gap:8px;">
            <span style="font-size:16px; font-weight:600;">⭐ ${movie.vote_average.toFixed(1)}</span>
            <span style="color:#666; font-size:13px;">(${movie.vote_count || 0} votes)</span>
        </div>
        <div id="user-rating-section" style="margin-top: 12px;"></div>
        ` : ''}

        <div class="overview" style="margin-top: ${movie.vote_average ? '16px' : '0'};">${escapeHtml(movie.overview || "No overview available.")}</div>

        ${movie.original_language || movie.production_countries ? `
        <div style="margin-top:8px; font-size:13px;">
            ${movie.original_language ? `
              <div ${spokenLanguagesStr ? `title="Available/Spoken Languages: ${escapeHtml(spokenLanguagesStr)}"` : ''} 
                   style="${spokenLanguagesStr ? 'cursor: help; text-decoration-line: underline; text-decoration-style: dotted; text-decoration-color: #999;' : ''}">
                <strong>Original Language:</strong> ${escapeHtml(getLanguageName(movie.original_language))}
              </div>` : ''}
            ${movie.production_countries && movie.production_countries.length > 0 ? `<div style="margin-top:4px;"><strong>Country:</strong> ${escapeHtml(movie.production_countries.join(', '))}</div>` : ''}
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

    modalBody.querySelectorAll(".cast-link").forEach(link => {
      link.addEventListener("click", () => {
        const actorName = link.getAttribute("data-name");
        addFilter("person", actorName, actorName);
        renderChips();
        loadPage(1);
        closeModal();
      });
    });

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
    
    modalBody.querySelectorAll(".provider-row").forEach(row => {
      row.style.cursor = 'pointer';
      row.addEventListener("click", (e) => {
        if (e.target.closest('a')) return;
        const providerName = row.dataset.provider;
        if (!selectedProviders.has(providerName)) {
          selectedProviders.add(providerName);
          const sidebarItem = document.querySelector(`.providerItem[data-provider="${CSS.escape(providerName)}"]`);
          if (sidebarItem) {
            sidebarItem.classList.add("selected");
            const checkbox = sidebarItem.querySelector("input[type='checkbox']");
            if (checkbox) {
              checkbox.checked = true;
            }
          }
          renderChips();
          loadPage(1);
          closeModal();
        } else {
          // Already selected, just close the modal
          closeModal();
        }
      });
    });

    // Preload similar movies/shows
    loadSimilarMovies(movieId, isTVShow);

    // Load user section if logged in
    loadUserSection(movieId, isTVShow);
  } catch (error) {
    console.error("Error opening modal:", error);
    modalTitle.textContent = "Error loading content";
    modalBody.innerHTML = "<div style='padding:16px;'>Error loading content. Please try again later.</div>";
  }
}

// Load user section with watchlist, rating, etc.
async function loadUserSection(movieId, isTVShow = false, isBoardGame = false) {
  const userRatingSection = document.getElementById("user-rating-section");
  if (!userRatingSection) return;

  const userId = localStorage.getItem("user_id");
  if (!userId) {
    userRatingSection.style.display = "none";
    return;
  }

  try {
    const contentType = isBoardGame ? 'boardgame' : (isTVShow ? 'tvshow' : 'movie');
    const userData = await getUserData(contentType);

    // Check if user has rated this item in our database
    const userRating = userData?.ratings?.[contentType]?.[movieId]?.rating || null;

    // Check if item is in user's watchlist in our database
    const isInWatchlist = userData?.lists?.[contentType]?.watchlist?.includes(String(movieId)) || false;

    const contentLabel = isBoardGame ? "game" : (isTVShow ? "show" : "movie");
    const listLabel = isBoardGame ? "Wishlist" : "Watchlist";

    userRatingSection.innerHTML = `
      <div style="padding: 12px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px; color: white;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
          <div style="font-weight: 600; font-size: 14px;">
            ${userRating ? `Your Rating: ⭐ ${userRating.toFixed(1)}` : `Rate this ${contentLabel}`}
          </div>
          <button id="toggle-watchlist-btn" style="background: rgba(255,255,255,0.25); border: 1px solid rgba(255,255,255,0.4); color: white; padding: 4px 12px; border-radius: 16px; cursor: pointer; font-size: 12px; font-weight: 500;">
            ${isInWatchlist ? `✓ ${listLabel}` : `+ ${listLabel}`}
          </button>
        </div>

        <div style="display: flex; gap: 4px; flex-wrap: wrap;">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(rating => `
            <button class="rating-btn" data-rating="${rating}" style="background: ${userRating === rating ? 'rgba(255,215,0,0.5)' : 'rgba(255,255,255,0.2)'}; border: 1px solid ${userRating === rating ? 'rgba(255,215,0,0.8)' : 'rgba(255,255,255,0.3)'}; color: white; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500; transition: all 0.2s; min-width: 36px;">
              ${rating}
            </button>
          `).join('')}
        </div>

        ${userRating ? `
          <button id="delete-rating-btn" style="margin-top: 8px; background: rgba(220,38,38,0.3); border: 1px solid rgba(220,38,38,0.5); color: white; padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 500; width: 100%;">
            Remove Rating
          </button>
        ` : ''}
      </div>
    `;

    // Add event listeners
    const toggleWatchlistBtn = document.getElementById('toggle-watchlist-btn');
    if (toggleWatchlistBtn) {
      toggleWatchlistBtn.addEventListener('click', async () => {
        await toggleWatchlist(movieId, isTVShow, !isInWatchlist, isBoardGame);
      });
    }

    const ratingBtns = userRatingSection.querySelectorAll('.rating-btn');
    ratingBtns.forEach(btn => {
      btn.addEventListener('click', async () => {
        const rating = parseFloat(btn.dataset.rating);
        await rateMedia(movieId, isTVShow, rating, isBoardGame);
      });
    });

    const deleteRatingBtn = document.getElementById('delete-rating-btn');
    if (deleteRatingBtn) {
      deleteRatingBtn.addEventListener('click', async () => {
        await deleteRating(movieId, isTVShow, isBoardGame);
      });
    }

  } catch (error) {
    console.error("[loadUserSection] Error:", error);
    userRatingSection.innerHTML = `<div style="padding: 8px; background: #fee; border-radius: 6px; color: #c00; font-size: 12px;">Error loading user data</div>`;
  }
}

// Toggle watchlist
async function toggleWatchlist(movieId, isTVShow, addToWatchlist, isBoardGame = false) {
  const userId = localStorage.getItem("user_id");
  if (!userId) return;

  try {
    const contentType = isBoardGame ? 'boardgame' : (isTVShow ? 'tvshow' : 'movie');
    const listName = isBoardGame ? 'wishlist' : 'watchlist';
    const action = addToWatchlist ? 'add_to_list' : 'remove_from_list';

    const response = await fetch(`${USER_DATA_API}?action=${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        item_id: String(movieId),
        list_name: listName,
        content_type: contentType
      })
    });

    const result = await response.json();
    if (result.success) {
      // Reload user section
      loadUserSection(movieId, isTVShow, isBoardGame);
      showToast(addToWatchlist ? `Added to ${listName}` : `Removed from ${listName}`);
    }
  } catch (error) {
    console.error("Error toggling watchlist:", error);
    showToast('Error updating list');
  }
}

// Rate media
async function rateMedia(movieId, isTVShow, rating, isBoardGame = false) {
  const userId = localStorage.getItem("user_id");
  if (!userId) return;

  try {
    const contentType = isBoardGame ? 'boardgame' : (isTVShow ? 'tvshow' : 'movie');

    const response = await fetch(`${USER_DATA_API}?action=rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        item_id: String(movieId),
        rating: rating,
        content_type: contentType
      })
    });

    const result = await response.json();
    if (result.success) {
      loadUserSection(movieId, isTVShow, isBoardGame);
      showToast(`Rated ${rating}/10`);
    }
  } catch (error) {
    console.error("Error rating media:", error);
    showToast('Error rating');
  }
}

// Delete rating
async function deleteRating(movieId, isTVShow, isBoardGame = false) {
  const userId = localStorage.getItem("user_id");
  if (!userId) return;

  try {
    const contentType = isBoardGame ? 'boardgame' : (isTVShow ? 'tvshow' : 'movie');

    const response = await fetch(`${USER_DATA_API}?action=delete_rating`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        item_id: String(movieId),
        content_type: contentType
      })
    });

    const result = await response.json();
    if (result.success) {
      loadUserSection(movieId, isTVShow, isBoardGame);
      showToast('Rating removed');
    }
  } catch (error) {
    console.error("Error deleting rating:", error);
    showToast('Error removing rating');
  }
}

// Load similar movies (fix for missing function)
async function loadSimilarMovies(movieId, isTVShow = false) {
  const container = document.getElementById("similar-movies-grid");
  if (!container) return;
  try {
    const data = await astraApi("similar", { id: movieId, limit: 10 });
    if (!data || !data.results || data.results.length === 0) {
      container.innerHTML = `<div class='subtle'>No similar titles found.</div>`;
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
    container.innerHTML = `<div class='subtle'>Error loading similar titles.</div>`;
  }
}

// Load similar board games
async function loadSimilarBoardGames(gameId) {
  const container = document.getElementById("similar-boardgames-grid");
  if (!container) return;
  try {
    const data = await astraApi("similar_boardgames", { id: gameId, limit: 10 });
    if (!data || !data.results || data.results.length === 0) {
      container.innerHTML = `<div class='subtle'>No similar games found.</div>`;
      return;
    }
    container.innerHTML = data.results.map(m => {
      const title = m.name0 || m.name || m.title;
      const thumbnail = m.image || m.thumbnail || null;
      const gameIdAttr = m.bggid || m.id;
      return `
      <div class="card similar-card" data-game-id="${gameIdAttr}" style="min-width: 100px; width: 100px; cursor: pointer; border:none; box-shadow:none; background:transparent;">
        ${thumbnail 
          ? `<img src="${escapeHtml(thumbnail)}" alt="${escapeHtml(title)}" style="width:100%; border-radius:8px; aspect-ratio: 1; object-fit: cover; background: #eee;">` 
          : `<div style="width:100%; border-radius:8px; aspect-ratio: 1; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center; color: white; font-size: 24px;">🎲</div>`
        }
        <div style="font-size:11px; margin-top:4px; line-height:1.2; max-height:2.4em; overflow:hidden; text-align:center;">${escapeHtml(title)}</div>
      </div>
    `}).join("");
    container.querySelectorAll(".similar-card").forEach(card => {
      card.addEventListener("click", () => {
        const newId = card.getAttribute("data-game-id");
        openMovieModal(newId, 'boardgame', 'bgg_board_games');
      });
    });
  } catch (e) {
    console.error(e);
    container.innerHTML = `<div class='subtle'>Error loading similar games.</div>`;
  }
}

// Load BGG user section for board games
async function loadBGGUserSection(gameId) {
  const userSection = document.getElementById("bgg-user-section");
  const userActions = document.getElementById("bgg-user-actions");
  if (!userSection || !userActions) return;

  const bggUsername = localStorage.getItem("bgg_username");
  if (!bggUsername) {
    userSection.style.display = "none";
    return;
  }

  try {
    // Get user's rating for this game
    const response = await fetch(`${BGG_AUTH_API}?action=get_rating&username=${encodeURIComponent(bggUsername)}&game_id=${gameId}`);

    if (response.status === 202) {
      // BGG is processing the request, show message
      userActions.innerHTML = `<div class="subtle" style="color: rgba(255,255,255,0.8);">Loading your BGG data...</div>`;
      // Retry after a delay
      setTimeout(() => loadBGGUserSection(gameId), 2000);
      return;
    }

    const data = await response.json();

    const userRating = data.rating;
    const owned = data.owned || false;
    const inCollection = data.inCollection || false;

    userActions.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 12px;">
        <div style="background: rgba(255,255,255,0.15); padding: 12px; border-radius: 8px;">
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 20px;">${owned ? '✓' : '📦'}</span>
              <span style="font-weight: 500;">${owned ? 'In Your Collection' : 'Not Owned'}</span>
            </div>
          </div>
        </div>

        <div style="background: rgba(255,255,255,0.15); padding: 12px; border-radius: 8px;">
          <div style="font-weight: 500; margin-bottom: 8px; display: flex; align-items: center; gap: 8px;">
            <span>⭐</span>
            <span>Your BGG Rating: ${userRating ? userRating.toFixed(1) : 'Not rated'}</span>
          </div>
          ${!inCollection ? `
            <div style="font-size: 12px; color: rgba(255,255,255,0.7); margin-top: 8px;">
              Rate this game on BoardGameGeek to see your rating here
            </div>
          ` : ''}
        </div>

        <a href="https://boardgamegeek.com/boardgame/${gameId}" target="_blank" rel="noopener noreferrer"
           style="display: block; text-align: center; background: rgba(255,255,255,0.25); border: 1px solid rgba(255,255,255,0.4); color: white; padding: 10px; border-radius: 8px; text-decoration: none; font-weight: 500; font-size: 13px; transition: all 0.2s;">
          View on BoardGameGeek →
        </a>
      </div>
    `;

  } catch (error) {
    console.error("Error loading BGG user section:", error);
    userActions.innerHTML = `<div class="subtle" style="color: rgba(255,255,255,0.8);">Error loading BGG data</div>`;
  }
}

// Initialize on page load - handle both cases (DOM ready or not)
if (document.readyState === 'loading') {
  document.addEventListener("DOMContentLoaded", () => {
    updateContentButtons();
    loadPage(1);
  });
} else {
  // DOM already loaded, run immediately
  updateContentButtons();
  loadPage(1);
}

// Initial UI update
updateUI();
loadSettings();

// Handle OAuth callback from TMDB
handleTmdbCallback();
