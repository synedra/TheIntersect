# Code Review & Improvement Suggestions

## 🎯 **High Priority Improvements**

### 1. **Security & Environment**

**Current Issues:**
- `NODE_TLS_REJECT_UNAUTHORIZED=0` in .env disables SSL verification (security risk)
- API keys exposed in repository if .env is committed
- No input sanitization in Netlify functions

**Recommendations:**
```bash
# Remove from .env:
NODE_TLS_REJECT_UNAUTHORIZED=0

# Add to .gitignore:
.env
.env.local
*.backup
dist/
.netlify/
```

**Add input validation to functions:**
```javascript
// In api.js and astra.js
function sanitizeInput(str) {
  return String(str).replace(/[<>]/g, '');
}
```

---

### 2. **Performance Optimizations**

**Netlify Functions - Astra.js:**
- **Issue**: Creating new DB client on every request is expensive
- **Fix**: Reuse client connection across invocations

```javascript
// At top of astra.js
let dbClient = null;
let dbConnection = null;

export async function handler(event) {
  // Reuse connection
  if (!dbClient) {
    dbClient = new DataAPIClient(process.env.ASTRA_DB_APPLICATION_TOKEN);
    dbConnection = dbClient.db(process.env.ASTRA_DB_API_ENDPOINT);
  }
  const moviesCollection = dbConnection.collection("moviesnew");
  // ... rest of code
}
```

**Frontend - Debouncing:**
- Current: 250ms debounce is good
- Add request cancellation for autocomplete

```javascript
let abortController = null;

searchInput.addEventListener("input", () => {
  clearTimeout(timer);
  if (abortController) abortController.abort();
  
  abortController = new AbortController();
  const raw = searchInput.value;

  timer = setTimeout(() => {
    getSuggestions(raw, abortController.signal)
      .then(renderSuggestions)
      .catch((e) => {
        if (e.name !== 'AbortError') {
          setStatus(e?.message || String(e));
        }
        showSuggestions(false);
      });
  }, 250);
});
```

---

### 3. **Error Handling & User Experience**

**Add Loading States:**
```javascript
// In main_astra.js
function setLoading(isLoading) {
  if (isLoading) {
    document.body.style.cursor = 'wait';
    output.style.opacity = '0.5';
  } else {
    document.body.style.cursor = '';
    output.style.opacity = '1';
  }
}
```

**Better Error Messages:**
```javascript
// Replace generic errors with user-friendly messages
const ERROR_MESSAGES = {
  NETWORK: "Can't connect to server. Please check your connection.",
  NOT_FOUND: "Movie not found.",
  TIMEOUT: "Request timed out. Please try again.",
  GENERIC: "Something went wrong. Please try again."
};
```

**Add Retry Logic:**
```javascript
async function fetchWithRetry(url, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}
```

---

### 4. **Code Organization & Maintainability**

**Split CSS into separate file:**
```bash
# Create styles.css
touch styles.css
```

```html
<!-- In index.html and index_astra.html -->
<link rel="stylesheet" href="/styles.css">
```

**Create utility modules:**
```javascript
// utils/api.js
export async function fetchAPI(endpoint, params) { ... }
export function escapeHtml(str) { ... }
export function debounce(fn, delay) { ... }

// utils/dom.js
export function createElement(html) { ... }
export function showModal(title, content) { ... }
```

**Extract constants:**
```javascript
// constants.js
export const IMG_BASE = "https://image.tmdb.org/t/p/w342";
export const DEBOUNCE_DELAY = 250;
export const MAX_RESULTS = 20;
export const AUTOCOMPLETE_LIMIT = 6;
```

---

### 5. **Accessibility (A11y)**

**Current Issues:**
- Missing ARIA labels
- Poor keyboard navigation
- No focus management in modals

**Fixes:**

```html
<!-- Add to search input -->
<input
  id="searchInput"
  class="inputInline"
  placeholder="Search actors, genres, keywords…"
  autocomplete="off"
  role="combobox"
  aria-autocomplete="list"
  aria-controls="suggestions"
  aria-expanded="false"
/>

<!-- Add to suggestions -->
<div 
  id="suggestions" 
  class="results" 
  role="listbox"
  aria-label="Search suggestions"
  style="display:none;"
></div>
```

**Keyboard Navigation:**
```javascript
// Add arrow key navigation for suggestions
let selectedIndex = -1;

searchInput.addEventListener("keydown", (e) => {
  const items = suggestionsEl.querySelectorAll('.resultItem');
  
  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
    updateSelection(items);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIndex = Math.max(selectedIndex - 1, 0);
    updateSelection(items);
  }
});
```

---

### 6. **Astra DB Optimizations**

**Add Pagination:**
```javascript
// In astra.js discover endpoint
case "discover": {
  const limit = parseInt(qs.limit) || 20;
  const page = parseInt(qs.page) || 1;
  const skip = (page - 1) * limit;

  const results = await moviesCollection.find({}, { 
    skip,
    limit,
    includeSimilarity: false
  }).toArray();

  return {
    statusCode: 200,
    body: JSON.stringify({ 
      results,
      page,
      hasMore: results.length === limit
    }),
    headers: { "Content-Type": "application/json" }
  };
}
```

**Add Caching:**
```javascript
// Simple in-memory cache
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
  const item = cache.get(key);
  if (item && Date.now() - item.timestamp < CACHE_TTL) {
    return item.data;
  }
  cache.delete(key);
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}
```

**Optimize Suggestions Query:**
```javascript
// Use $limit projection instead of fetching all then filtering
const people = await moviesCollection.find(
  { "cast.name": { $regex: query, $options: "i" } },
  { 
    limit: 20, // Get more docs but limit projection
    projection: { 
      "cast": { $slice: 10 } // Only first 10 cast members
    } 
  }
).toArray();
```

---

### 7. **Package.json Improvements**

**Add Scripts:**
```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "netlify:dev": "netlify dev",
    "lint": "eslint .",
    "format": "prettier --write .",
    "test": "echo 'No tests yet'",
    "clean": "rm -rf dist .netlify node_modules"
  }
}
```

**Add Development Dependencies:**
```json
{
  "devDependencies": {
    "vite": "^5.4.21",
    "eslint": "^8.0.0",
    "prettier": "^3.0.0"
  }
}
```

---

### 8. **Missing Features to Add**

**Infinite Scroll:**
```javascript
// Add to main_astra.js
const observer = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && !loading) {
    loadMoreResults();
  }
});
```

**Search History:**
```javascript
// Store recent searches in localStorage
const SEARCH_HISTORY_KEY = 'movieSearchHistory';

function saveSearch(searchTerms) {
  const history = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]');
  history.unshift(searchTerms);
  localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history.slice(0, 10)));
}
```

**Favorites/Watchlist:**
```javascript
// Add to localStorage or user account
function toggleFavorite(movieId) {
  const favorites = JSON.parse(localStorage.getItem('favorites') || '[]');
  const index = favorites.indexOf(movieId);
  
  if (index > -1) {
    favorites.splice(index, 1);
  } else {
    favorites.push(movieId);
  }
  
  localStorage.setItem('favorites', JSON.stringify(favorites));
}
```

---

### 9. **Testing Recommendations**

**Add Test Files:**
```javascript
// tests/utils.test.js
import { escapeHtml, tokenKey } from '../utils.js';

describe('escapeHtml', () => {
  it('should escape HTML special characters', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });
});
```

**E2E Testing:**
```bash
npm install --save-dev playwright
```

---

### 10. **Documentation Improvements**

**Add JSDoc Comments:**
```javascript
/**
 * Fetches movie data from Astra DB
 * @param {string} action - The action to perform (discover, get, similar, suggestions)
 * @param {Object} params - Query parameters
 * @returns {Promise<Object>} The API response data
 * @throws {Error} If the API request fails
 */
async function astraApi(action, params) {
  // ...
}
```

**Add Component Documentation:**
```markdown
# Component Structure

## main_astra.js
- `renderGrid()` - Displays movie grid
- `openMovieModal()` - Shows movie details
- `openSimilarModal()` - Shows similar movies using vector search
- `getSuggestions()` - Autocomplete for search
```

---

## 📊 **File-Specific Recommendations**

### **netlify/functions/astra.js**
- ✅ Move collection name to environment variable
- ✅ Add request timeout handling
- ✅ Implement proper error logging
- ✅ Add rate limiting
- ✅ Use connection pooling

### **main_astra.js**
- ✅ Extract duplicate code into functions
- ✅ Add loading spinners
- ✅ Implement virtual scrolling for large lists
- ✅ Add keyboard shortcuts
- ✅ Improve mobile responsiveness

### **index_astra.html**
- ✅ Move inline styles to external CSS
- ✅ Add meta tags for SEO
- ✅ Add Open Graph tags
- ✅ Optimize for mobile (viewport meta)
- ✅ Add PWA manifest

### **.gitignore**
- ✅ Add more patterns:
```
*.backup
.DS_Store
*.log
.vscode/
.idea/
```

---

## 🚀 **Quick Wins (Implement Now)**

1. **Remove `NODE_TLS_REJECT_UNAUTHORIZED=0`** from .env
2. **Add `.env` to .gitignore** if not already there
3. **Extract CSS to separate file** for better organization
4. **Add loading spinner** to improve perceived performance
5. **Implement error boundaries** for better error handling
6. **Add meta description** to HTML for SEO
7. **Cache DB connection** in Astra function
8. **Add request cancellation** to autocomplete

---

## 🎨 **UI/UX Enhancements**

1. **Empty States**: Show helpful message when no results
2. **Skeletons**: Add skeleton loaders while content loads
3. **Transitions**: Smooth animations for modal open/close
4. **Toast Notifications**: Show success/error messages
5. **Mobile Menu**: Collapsible sidebar on mobile
6. **Dark Mode**: Add theme toggle
7. **Responsive Images**: Use srcset for different screen sizes

---

## 🔒 **Security Checklist**

- [ ] Remove NODE_TLS_REJECT_UNAUTHORIZED=0
- [ ] Add rate limiting to API endpoints
- [ ] Sanitize all user inputs
- [ ] Add CORS headers properly
- [ ] Use Content Security Policy
- [ ] Add request size limits
- [ ] Implement API key rotation
- [ ] Add request logging/monitoring

---

## 📈 **Performance Metrics to Track**

1. Time to First Byte (TTFB)
2. Largest Contentful Paint (LCP)
3. First Input Delay (FID)
4. Cumulative Layout Shift (CLS)
5. API response times
6. Vector search latency

Use Lighthouse or WebPageTest to measure these.

---

## 🎯 **Priority Order**

**Phase 1 (Now):**
1. Security fixes
2. Error handling
3. Code organization

**Phase 2 (Next Week):**
1. Performance optimizations
2. Accessibility improvements
3. Testing setup

**Phase 3 (Future):**
1. New features
2. PWA capabilities
3. Advanced analytics
