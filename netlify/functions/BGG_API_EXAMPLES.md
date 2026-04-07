# BoardGameGeek API Function - Usage Examples

The BGG Netlify function provides access to BoardGameGeek's XML API 2 for game information, user collections, ratings, and more.

## Base URL

**Local Development:**
```
http://localhost:8888/.netlify/functions/bgg
```

**Production:**
```
https://theintersect.netlify.app/.netlify/functions/bgg
```

## API Actions

### 1. Get Game Information

Get detailed information about one or more board games by ID.

**Single game:**
```javascript
// Get Apiary (ID: 400314)
fetch('/.netlify/functions/bgg?action=game&id=400314')
  .then(res => res.json())
  .then(data => {
    const game = data.games[0];
    console.log(`${game.name} (${game.year})`);
    console.log(`Rating: ${game.stats.average}`);
    console.log(`Rank: ${game.stats.rank}`);
  });
```

**Multiple games:**
```javascript
// Get multiple games at once
fetch('/.netlify/functions/bgg?action=game&id=400314,224517,174430')
  .then(res => res.json())
  .then(data => {
    data.games.forEach(game => {
      console.log(`${game.name}: ${game.stats.average}/10`);
    });
  });
```

**Without statistics (faster):**
```javascript
fetch('/.netlify/functions/bgg?action=game&id=400314&stats=0')
  .then(res => res.json())
  .then(data => console.log(data.games[0]));
```

**Response Format:**
```json
{
  "games": [
    {
      "id": "400314",
      "name": "Apiary",
      "alternateNames": [],
      "year": "2023",
      "thumbnail": "https://cf.geekdo-images.com/...",
      "image": "https://cf.geekdo-images.com/...",
      "description": "In a far-distant future...",
      "minPlayers": "1",
      "maxPlayers": "5",
      "playingTime": "90",
      "minPlayTime": "60",
      "maxPlayTime": "90",
      "minAge": "14",
      "stats": {
        "usersRated": 5432,
        "average": 7.7,
        "bayesAverage": 7.5,
        "rank": "313",
        "weight": 3.2
      },
      "categories": ["Animals", "Economic", "Science Fiction"],
      "mechanics": ["Worker Placement", "End Game Bonuses"],
      "designers": ["Connie Vogelmann"],
      "publishers": ["Stonemaier Games"]
    }
  ]
}
```

---

### 2. Search for Games

Search BoardGameGeek by game name.

**Fuzzy search:**
```javascript
// Find all games matching "wingspan"
fetch('/.netlify/functions/bgg?action=search&query=wingspan')
  .then(res => res.json())
  .then(data => {
    data.results.forEach(game => {
      console.log(`${game.name} (${game.year}) - ID: ${game.id}`);
    });
  });
```

**Exact match:**
```javascript
// Find exact match for "Apiary"
fetch('/.netlify/functions/bgg?action=search&query=Apiary&exact=1')
  .then(res => res.json())
  .then(data => {
    const game = data.results[0];
    console.log(`Found: ${game.name} (ID: ${game.id})`);
  });
```

**Response Format:**
```json
{
  "results": [
    {
      "id": "400314",
      "name": "Apiary",
      "year": "2023",
      "type": "boardgame"
    }
  ]
}
```

---

### 3. Get User Collection

Get a BGG user's game collection, ratings, or wishlist.

**Get owned games:**
```javascript
// Get all games owned by user "username"
fetch('/.netlify/functions/bgg?action=collection&username=USERNAME&own=1')
  .then(res => res.json())
  .then(data => {
    console.log(`${data.username} owns ${data.totalItems} games`);
    data.collection.forEach(item => {
      console.log(item.name);
    });
  });
```

**Get rated games:**
```javascript
// Get all games the user has rated
fetch('/.netlify/functions/bgg?action=collection&username=USERNAME&rated=1')
  .then(res => res.json())
  .then(data => {
    data.collection.forEach(item => {
      console.log(`${item.name}: ${item.stats.rating.value}/10`);
    });
  });
```

**Get wishlist:**
```javascript
// Get user's wishlist (priority 1-5, where 1 = highest)
fetch('/.netlify/functions/bgg?action=collection&username=USERNAME&wishlist=1&wishlistpriority=1')
  .then(res => res.json())
  .then(data => {
    console.log('High priority wishlist:');
    data.collection.forEach(item => {
      console.log(item.name);
    });
  });
```

**Collection parameters:**
- `own=1` - Games the user owns
- `rated=1` - Games the user has rated
- `wishlist=1` - Games on wishlist
- `wishlistpriority=1` - Filter by wishlist priority (1-5)
- `wanttoplay=1` - Games marked "want to play"
- `wanttobuy=1` - Games marked "want to buy"
- `stats=1` - Include statistics (default: on)

**Response Format:**
```json
{
  "username": "USERNAME",
  "totalItems": "142",
  "collection": [
    {
      "objecttype": "thing",
      "objectid": "400314",
      "name": "Apiary",
      "yearpublished": "2023",
      "image": "https://...",
      "thumbnail": "https://...",
      "status": {
        "own": "1",
        "prevowned": "0",
        "fortrade": "0",
        "want": "0",
        "wanttoplay": "1",
        "wishlist": "0"
      },
      "numplays": "5"
    }
  ]
}
```

---

### 4. Get Hot Games

Get the current "hot" games list from BoardGameGeek.

```javascript
// Get current hot board games
fetch('/.netlify/functions/bgg?action=hot')
  .then(res => res.json())
  .then(data => {
    console.log('Top 50 Hot Games:');
    data.hot.forEach((game, index) => {
      console.log(`${index + 1}. ${game.name.value} (${game.yearpublished.value})`);
    });
  });
```

**Response Format:**
```json
{
  "hot": [
    {
      "id": "400314",
      "rank": "1",
      "thumbnail": {
        "value": "https://...",
        "value": "https://..."
      },
      "name": {
        "value": "Apiary",
        "value": "Apiary"
      },
      "yearpublished": {
        "value": "2023",
        "value": "2023"
      }
    }
  ]
}
```

---

### 5. Rate a Game

Submit a rating for a board game (stored locally in Astra DB).

**Rate a game:**
```javascript
// Rate a game (1-10 scale)
fetch('/.netlify/functions/bgg?action=rate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    game_id: '400314',      // Apiary
    user_id: 'user123',     // Your user ID (from Auth0 or session)
    rating: 8.5,            // 1-10 scale
    review: 'Great worker placement game!' // Optional
  })
})
  .then(res => res.json())
  .then(data => {
    console.log('Rating saved:', data.rating);
  });
```

**Get user's ratings:**
```javascript
// Get all ratings by a specific user
fetch('/.netlify/functions/bgg?action=get_ratings&user_id=user123')
  .then(res => res.json())
  .then(data => {
    console.log(`User has rated ${data.count} games`);
    data.ratings.forEach(r => {
      console.log(`Game ${r.game_id}: ${r.rating}/10`);
    });
  });
```

**Get ratings for a specific game:**
```javascript
// Get all ratings for Apiary
fetch('/.netlify/functions/bgg?action=get_ratings&game_id=400314')
  .then(res => res.json())
  .then(data => {
    const avgRating = data.ratings.reduce((sum, r) => sum + r.rating, 0) / data.count;
    console.log(`Apiary average: ${avgRating.toFixed(1)}/10 (${data.count} ratings)`);
  });
```

**Check if user has rated a game:**
```javascript
// Get specific user's rating for a specific game
fetch('/.netlify/functions/bgg?action=get_ratings&user_id=user123&game_id=400314')
  .then(res => res.json())
  .then(data => {
    if (data.ratings.length > 0) {
      console.log(`You rated this ${data.ratings[0].rating}/10`);
    } else {
      console.log('You have not rated this game');
    }
  });
```

**Delete a rating:**
```javascript
// Remove your rating
fetch('/.netlify/functions/bgg?action=delete_rating', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    game_id: '400314',
    user_id: 'user123'
  })
})
  .then(res => res.json())
  .then(data => {
    console.log('Rating deleted:', data.success);
  });
```

**Response Formats:**

Rate a game:
```json
{
  "success": true,
  "message": "Rating saved",
  "rating": {
    "_id": "user123_400314",
    "user_id": "user123",
    "game_id": "400314",
    "rating": 8.5,
    "review": "Great worker placement game!",
    "rated_at": "2026-02-08T16:40:00.000Z"
  }
}
```

Get ratings:
```json
{
  "ratings": [
    {
      "_id": "user123_400314",
      "user_id": "user123",
      "game_id": "400314",
      "rating": 8.5,
      "review": "Great worker placement game!",
      "rated_at": "2026-02-08T16:40:00.000Z"
    }
  ],
  "count": 1
}
```

---

## Error Handling

All endpoints return proper HTTP status codes and error messages:

```javascript
fetch('/.netlify/functions/bgg?action=game&id=999999999')
  .then(res => res.json())
  .then(data => {
    if (data.error) {
      console.error('Error:', data.error);
    }
  })
  .catch(err => console.error('Network error:', err));
```

**Common errors:**
- `400` - Missing or invalid parameters
- `404` - Game not found
- `500` - BGG API error or internal error

---

## Rate Limiting

BoardGameGeek API has rate limits. Best practices:

1. **Cache results** - Store game info locally after first fetch
2. **Batch requests** - Request multiple game IDs at once (`id=123,456,789`)
3. **Handle 202 responses** - BGG returns 202 when processing; the function auto-retries once

---

## Integration Example

Complete example of searching for a game and displaying details:

```javascript
async function findAndDisplayGame(searchTerm) {
  try {
    // 1. Search for the game
    const searchRes = await fetch(
      `/.netlify/functions/bgg?action=search&query=${encodeURIComponent(searchTerm)}&exact=1`
    );
    const searchData = await searchRes.json();

    if (searchData.results.length === 0) {
      console.log('Game not found');
      return;
    }

    const gameId = searchData.results[0].id;

    // 2. Get detailed game info
    const gameRes = await fetch(
      `/.netlify/functions/bgg?action=game&id=${gameId}`
    );
    const gameData = await gameRes.json();
    const game = gameData.games[0];

    // 3. Display game details
    console.log(`
      ${game.name} (${game.year})
      Rating: ${game.stats.average}/10 (Rank: ${game.stats.rank})
      Players: ${game.minPlayers}-${game.maxPlayers}
      Play Time: ${game.playingTime} minutes
      Categories: ${game.categories.join(', ')}
      Mechanics: ${game.mechanics.join(', ')}
    `);

  } catch (error) {
    console.error('Error fetching game:', error);
  }
}

// Usage
findAndDisplayGame('Apiary');
```

---

## Notes

- **Authentication:** The function uses a BGG token for API requests (configured in environment variables)
- **User data:** Collection/wishlist/ratings require a public BGG username
- **XML to JSON:** BGG's XML API is automatically converted to JSON for easier frontend use
- **Caching:** Consider implementing client-side caching for frequently accessed games
