# User Data API - Unified Ratings & Lists

A unified system for tracking user ratings and lists across **board games**, **movies**, and **TV shows**.

## Database Structure

Single collection: `user_data` in Astra DB (boardgames keyspace)

Each user has one document:
```json
{
  "_id": "user123",
  "ratings": {
    "boardgame": {
      "400314": {
        "rating": 8.5,
        "review": "Great worker placement!",
        "content_type": "boardgame",
        "rated_at": "2026-02-08T17:00:00.000Z"
      }
    },
    "movie": {
      "550": {
        "rating": 9.0,
        "review": "Best movie ever!",
        "content_type": "movie",
        "rated_at": "2026-02-08T17:00:00.000Z"
      }
    },
    "tvshow": {
      "1399": {
        "rating": 8.5,
        "review": "Epic fantasy series",
        "content_type": "tvshow",
        "rated_at": "2026-02-08T17:00:00.000Z"
      }
    }
  },
  "lists": {
    "boardgame": {
      "wishlist": ["400314", "224517"],
      "owned": ["174430"],
      "want_to_play": ["400314"],
      "favorites": [],
      "played": []
    },
    "movie": {
      "watchlist": ["550", "680"],
      "favorites": ["550"],
      "watched": ["680"]
    },
    "tvshow": {
      "watchlist": ["1399"],
      "favorites": [],
      "watching": ["1399"],
      "watched": []
    }
  }
}
```

---

## API Endpoints

All endpoints use: `/.netlify/functions/bgg`

### 1. Rate Content

Rate a board game, movie, or TV show.

**Endpoint:** `POST /.netlify/functions/bgg?action=rate`

**Body:**
```json
{
  "item_id": "400314",           // BGG ID, TMDB movie ID, or TMDB TV ID
  "user_id": "user123",          // Auth0 user ID
  "rating": 8.5,                 // 1-10 scale
  "review": "Great game!",       // Optional
  "content_type": "boardgame"    // "boardgame", "movie", or "tvshow"
}
```

**Example:**
```javascript
// Rate Apiary (board game)
await fetch('/.netlify/functions/bgg?action=rate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    item_id: '400314',
    user_id: 'auth0|123',
    rating: 8.5,
    review: 'Love the theme!',
    content_type: 'boardgame'
  })
});

// Rate Fight Club (movie)
await fetch('/.netlify/functions/bgg?action=rate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    item_id: '550',
    user_id: 'auth0|123',
    rating: 9.0,
    content_type: 'movie'
  })
});
```

---

### 2. Get User Data

Get all ratings and lists for a user (across all content types or filtered).

**Endpoint:** `GET /.netlify/functions/bgg?action=get_user_data&user_id=USER_ID`

**Query Parameters:**
- `user_id` (required) - The user's ID
- `content_type` (optional) - Filter by "boardgame", "movie", or "tvshow"

**Example:**
```javascript
// Get all user data
const response = await fetch('/.netlify/functions/bgg?action=get_user_data&user_id=user123');
const data = await response.json();

console.log(data.ratings.boardgame);  // All board game ratings
console.log(data.ratings.movie);      // All movie ratings
console.log(data.ratings.tvshow);     // All TV show ratings

console.log(data.lists.boardgame.wishlist);  // Board game wishlist
console.log(data.lists.movie.watchlist);     // Movie watchlist
```

**Get specific content type:**
```javascript
// Get only board game data
const response = await fetch('/.netlify/functions/bgg?action=get_user_data&user_id=user123&content_type=boardgame');
const data = await response.json();

console.log(data.ratings);  // Only board game ratings
console.log(data.lists);    // Only board game lists
```

**Response:**
```json
{
  "user_id": "user123",
  "ratings": {
    "boardgame": { ... },
    "movie": { ... },
    "tvshow": { ... }
  },
  "lists": {
    "boardgame": {
      "wishlist": ["400314"],
      "owned": [],
      "want_to_play": [],
      "favorites": [],
      "played": []
    },
    "movie": {
      "watchlist": ["550"],
      "favorites": [],
      "watched": []
    },
    "tvshow": {
      "watchlist": [],
      "favorites": [],
      "watching": [],
      "watched": []
    }
  }
}
```

---

### 3. Add to List

Add an item to one of the user's lists.

**Endpoint:** `POST /.netlify/functions/bgg?action=add_to_list`

**Body:**
```json
{
  "item_id": "400314",
  "user_id": "user123",
  "list_name": "wishlist",
  "content_type": "boardgame"
}
```

**Valid lists by content type:**
- **boardgame**: `wishlist`, `owned`, `want_to_play`, `favorites`, `played`
- **movie**: `watchlist`, `favorites`, `watched`
- **tvshow**: `watchlist`, `favorites`, `watching`, `watched`

**Example:**
```javascript
// Add Apiary to wishlist
await fetch('/.netlify/functions/bgg?action=add_to_list', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    item_id: '400314',
    user_id: 'user123',
    list_name: 'wishlist',
    content_type: 'boardgame'
  })
});

// Add movie to watchlist
await fetch('/.netlify/functions/bgg?action=add_to_list', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    item_id: '550',
    user_id: 'user123',
    list_name: 'watchlist',
    content_type: 'movie'
  })
});
```

---

### 4. Remove from List

Remove an item from a user's list.

**Endpoint:** `POST /.netlify/functions/bgg?action=remove_from_list`

**Body:**
```json
{
  "item_id": "400314",
  "user_id": "user123",
  "list_name": "wishlist",
  "content_type": "boardgame"
}
```

**Example:**
```javascript
await fetch('/.netlify/functions/bgg?action=remove_from_list', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    item_id: '400314',
    user_id: 'user123',
    list_name: 'wishlist',
    content_type: 'boardgame'
  })
});
```

---

### 5. Delete Rating

Remove a rating from a user's data.

**Endpoint:** `POST /.netlify/functions/bgg?action=delete_rating`

**Body:**
```json
{
  "item_id": "400314",
  "user_id": "user123",
  "content_type": "boardgame"
}
```

**Example:**
```javascript
await fetch('/.netlify/functions/bgg?action=delete_rating', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    item_id: '400314',
    user_id: 'user123',
    content_type: 'boardgame'
  })
});
```

---

## Frontend Integration Example

```javascript
class UserDataManager {
  constructor(userId) {
    this.userId = userId;
    this.baseUrl = '/.netlify/functions/bgg';
  }

  async rate(itemId, rating, contentType, review = null) {
    const response = await fetch(`${this.baseUrl}?action=rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item_id: String(itemId),
        user_id: this.userId,
        rating,
        content_type: contentType,
        review
      })
    });
    return response.json();
  }

  async addToList(itemId, listName, contentType) {
    const response = await fetch(`${this.baseUrl}?action=add_to_list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item_id: String(itemId),
        user_id: this.userId,
        list_name: listName,
        content_type: contentType
      })
    });
    return response.json();
  }

  async removeFromList(itemId, listName, contentType) {
    const response = await fetch(`${this.baseUrl}?action=remove_from_list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item_id: String(itemId),
        user_id: this.userId,
        list_name: listName,
        content_type: contentType
      })
    });
    return response.json();
  }

  async getUserData(contentType = null) {
    let url = `${this.baseUrl}?action=get_user_data&user_id=${this.userId}`;
    if (contentType) {
      url += `&content_type=${contentType}`;
    }
    const response = await fetch(url);
    return response.json();
  }

  async deleteRating(itemId, contentType) {
    const response = await fetch(`${this.baseUrl}?action=delete_rating`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item_id: String(itemId),
        user_id: this.userId,
        content_type: contentType
      })
    });
    return response.json();
  }

  // Helper: Check if user rated an item
  async hasRated(itemId, contentType) {
    const data = await this.getUserData(contentType);
    return !!data.ratings?.[itemId];
  }

  // Helper: Check if item is in a list
  async isInList(itemId, listName, contentType) {
    const data = await this.getUserData(contentType);
    return data.lists?.[listName]?.includes(String(itemId)) || false;
  }
}

// Usage
const userManager = new UserDataManager('auth0|123');

// Rate a board game
await userManager.rate('400314', 8.5, 'boardgame', 'Love this game!');

// Add movie to watchlist
await userManager.addToList('550', 'watchlist', 'movie');

// Check if user owns a game
const ownsGame = await userManager.isInList('400314', 'owned', 'boardgame');

// Get all user data
const allData = await userManager.getUserData();
console.log(allData.ratings.boardgame);
console.log(allData.lists.movie.watchlist);
```

---

## Migration from Separate Collections

If you have existing `bgg_user_ratings` collection, you'll need to migrate:

```javascript
// Migration script (run once)
const oldRatings = await db.collection('bgg_user_ratings').find({}).toArray();

for (const rating of oldRatings) {
  await db.collection('user_data').updateOne(
    { _id: rating.user_id },
    {
      $set: {
        [`ratings.boardgame.${rating.game_id}`]: {
          rating: rating.rating,
          review: rating.review,
          content_type: 'boardgame',
          rated_at: rating.rated_at
        }
      }
    },
    { upsert: true }
  );
}
```

---

## Benefits of Unified Structure

✅ **Single source of truth** - All user data in one document
✅ **Consistent API** - Same endpoints for games, movies, and TV shows
✅ **Efficient queries** - One DB call to get all user data
✅ **Easy to extend** - Add new content types or list types easily
✅ **Better UX** - Unified "My Profile" page across all content

---

## Database Index Recommendations

Create index on user_id for fast lookups:
```javascript
db.collection('user_data').createIndex({ _id: 1 });
```

No additional indexes needed since we always query by user_id.
