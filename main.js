let currentPage = 1;
let currentGenre = "";
let currentQuery = "";
let totalPages = 0;
let debounceTimer;

const genreMapping = {
  28: "Action",
  12: "Adventure",
  16: "Animation",
  35: "Comedy",
  80: "Crime",
  99: "Documentary",
  18: "Drama",
  10751: "Family",
  14: "Fantasy",
  36: "History",
  27: "Horror",
  10402: "Music",
  9648: "Mystery",
  10749: "Romance",
  878: "Science Fiction",
  10770: "TV Movie",
  53: "Thriller",
  10752: "War",
  37: "Western",
};

const modalOverlay = document.getElementById("modalOverlay");
const modalTitle = document.getElementById("modalTitle");
const modalSubtitle = document.getElementById("modalSubtitle");
const modalBody = document.getElementById("modalBody");
const modalClose = document.getElementById("modalClose");

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

  // Handle both TMDB format (array of IDs) and Astra DB format (array of objects)
  if (typeof genreData[0] === 'number') {
    // TMDB format: [28, 12, 16]
    return genreData
      .map((id) => genreMapping[id] || "Unknown")
      .filter((name) => name !== "Unknown")
      .join(", ");
  } else {
    // Astra DB format: [{id: 28, name: "Action"}, ...]
    return genreData
      .map((genre) => genre.name || "Unknown")
      .filter((name) => name !== "Unknown")
      .join(", ");
  }
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
    if (currentQuery) {
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
      data.vote_average ? `⭐ ${data.vote_average.toFixed(1)}` : ""
    ].filter(Boolean).join(" • ");

    const posterHtml = data.poster_path
      ? `<img src="https://image.tmdb.org/t/p/w500${data.poster_path}" alt="${escapeHtml(data.title)}" />`
      : `<div class="noposter" style="height:320px;">No poster</div>`;

    // Handle genres (array of objects or strings)
    let genresHtml = "";
    if (Array.isArray(data.genres)) {
      genresHtml = data.genres.map(g => 
        typeof g === 'object' ? `<span class="pill">${escapeHtml(g.name)}</span>` : `<span class="pill">${escapeHtml(g)}</span>`
      ).join("");
    }

    // Handle cast
    let castHtml = "";
    if (Array.isArray(data.cast)) {
      castHtml = data.cast.slice(0, 10).map(c => 
        typeof c === 'object' ? `<span class="pill">${escapeHtml(c.name)}</span>` : `<span class="pill">${escapeHtml(c)}</span>`
      ).join("");
    } else if (Array.isArray(data.credits?.cast)) {
       castHtml = data.credits.cast.slice(0, 10).map(c => 
        `<span class="pill">${escapeHtml(c.name)}</span>`
      ).join("");
    }

    // Handle keywords
    let keywordsHtml = "";
    if (Array.isArray(data.keywords)) {
      keywordsHtml = data.keywords.slice(0, 12).map(k => 
        typeof k === 'object' ? `<span class="pill">${escapeHtml(k.name)}</span>` : `<span class="pill">${escapeHtml(k)}</span>`
      ).join("");
    }

    modalBody.innerHTML = `
      <div class="poster">${posterHtml}</div>
      <div>
        <div class="overview">${escapeHtml(data.overview || "No overview available.")}</div>

        ${genresHtml ? `
        <div class="sectionTitle">Genres</div>
        <div class="pillRow">${genresHtml}</div>
        ` : ''}

        ${castHtml ? `
        <div class="sectionTitle">Top Cast</div>
        <div class="pillRow">${castHtml}</div>
        ` : ''}

        ${keywordsHtml ? `
        <div class="sectionTitle">Keywords</div>
        <div class="pillRow">${keywordsHtml}</div>
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

async function setupAutocomplete() {
  const searchInput = document.getElementById("search-input");
  const autocompleteList = document.getElementById("autocomplete-list");

  if (!searchInput || !autocompleteList) return;

  searchInput.addEventListener("input", async (e) => {
    const query = e.target.value.trim();

    clearTimeout(debounceTimer);

    if (query.length < 2) {
      autocompleteList.innerHTML = "";
      autocompleteList.style.display = "none";
      return;
    }

    debounceTimer = setTimeout(async () => {
      try {
        const data = await astraApi("autocomplete", { query });

        autocompleteList.innerHTML = "";

        if (data && data.results && data.results.length > 0) {
          data.results.slice(0, 5).forEach((movie) => {
            const item = document.createElement("div");
            item.className = "autocomplete-item";

            const posterPath = movie.poster_path
              ? `https://image.tmdb.org/t/p/w92${movie.poster_path}`
              : "https://via.placeholder.com/92x138?text=No+Image";

            item.innerHTML = `
              <img src="${posterPath}" alt="${movie.title}">
              <div class="autocomplete-info">
                <div class="autocomplete-title">${movie.title}</div>
                <div class="autocomplete-year">${movie.release_date ? new Date(movie.release_date).getFullYear() : "N/A"}</div>
              </div>
            `;

            item.addEventListener("click", () => {
              openMovieModal(movie._id);
              autocompleteList.innerHTML = "";
              autocompleteList.style.display = "none";
              searchInput.value = "";
            });

            autocompleteList.appendChild(item);
          });

          autocompleteList.style.display = "block";
        } else {
          autocompleteList.style.display = "none";
        }
      } catch (error) {
        console.error("Error fetching autocomplete:", error);
        autocompleteList.style.display = "none";
      }
    }, 300);
  });

  document.addEventListener("click", (e) => {
    if (e.target !== searchInput && !autocompleteList.contains(e.target)) {
      autocompleteList.innerHTML = "";
      autocompleteList.style.display = "none";
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  loadPage(1);
  setupAutocomplete();

  const searchForm = document.getElementById("search-form");
  const searchInput = document.getElementById("search-input");
  const genreFilter = document.getElementById("genre-filter");
  // const modalClose = document.querySelector(".modal-close");
  // const modal = document.getElementById("movie-modal");

  if (searchForm && searchInput) {
    searchForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const query = searchInput.value.trim();

      if (query.length < 2) {
        alert("Please enter at least 2 characters to search.");
        return;
      }

      currentQuery = query;
      currentGenre = "";
      if (genreFilter) genreFilter.value = "";
      loadPage(1);

      const autocompleteList = document.getElementById("autocomplete-list");
      if (autocompleteList) {
        autocompleteList.innerHTML = "";
        autocompleteList.style.display = "none";
      }
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

