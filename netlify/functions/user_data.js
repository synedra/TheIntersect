import { DataAPIClient } from "@datastax/astra-db-ts";
import dotenv from "dotenv";

dotenv.config({ override: true });

// Connect to Intersect database (dedicated user data database)
const client = new DataAPIClient(process.env.ASTRA_INTERSECT_APPLICATION_TOKEN);
const db = client.db(process.env.ASTRA_INTERSECT_ENDPOINT);
const usersCollection = db.collection('intersect_users');

export async function handler(event) {
  const qs = event.queryStringParameters || {};
  const action = qs.action;

  let body = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      console.error("Error parsing body", e);
    }
  }

  try {
    switch (action) {
      // Get all user data (ratings + lists) for a user
      case "get_user_data": {
        const userId = qs.user_id;
        const username = qs.username; // Optional: TMDB username for new users

        if (!userId) {
          return { statusCode: 400, body: JSON.stringify({ error: "Missing user_id" }) };
        }

        let userData = await usersCollection.findOne({ _id: userId });

        // If user doesn't exist, create empty structure
        if (!userData) {
          userData = {
            _id: userId,
            username: username || userId, // Use TMDB username or fallback to user_id
            ratings: { boardgame: {}, movie: {}, tvshow: {} },
            lists: {
              boardgame: { wishlist: [], owned: [], want_to_play: [], favorites: [], played: [] },
              movie: { watchlist: [], favorites: [], watched: [] },
              tvshow: { watchlist: [], favorites: [], watching: [], watched: [] }
            },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };

          await usersCollection.insertOne(userData);
        } else if (username && !userData.username) {
          // Update existing user without username
          await usersCollection.updateOne(
            { _id: userId },
            { $set: { username: username } }
          );
          userData.username = username;
        }

        // Filter by content_type if specified
        const contentType = qs.content_type;
        if (contentType && ['boardgame', 'movie', 'tvshow'].includes(contentType)) {
          return {
            statusCode: 200,
            body: JSON.stringify({
              user_id: userId,
              ratings: { [contentType]: userData.ratings[contentType] || {} },
              lists: { [contentType]: userData.lists[contentType] || {} },
              item_metadata: { [contentType]: userData.item_metadata?.[contentType] || {} }
            })
          };
        }

        return { statusCode: 200, body: JSON.stringify(userData) };
      }

      // Rate content (movie, TV show, or board game)
      case "rate": {
        const { user_id, item_id, rating, review, content_type } = body;

        if (!user_id || !item_id || rating === undefined || !content_type) {
          return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields" }) };
        }

        if (!['boardgame', 'movie', 'tvshow'].includes(content_type)) {
          return { statusCode: 400, body: JSON.stringify({ error: "Invalid content_type" }) };
        }

        const ratingData = {
          rating: parseFloat(rating),
          content_type,
          rated_at: new Date().toISOString()
        };

        if (review) {
          ratingData.review = review;
        }

        const result = await usersCollection.updateOne(
          { _id: user_id },
          {
            $set: {
              [`ratings.${content_type}.${item_id}`]: ratingData,
              updated_at: new Date().toISOString()
            }
          },
          { upsert: true }
        );

        return { statusCode: 200, body: JSON.stringify({ success: true, rating: ratingData }) };
      }

      // Delete rating
      case "delete_rating": {
        const { user_id, item_id, content_type } = body;

        if (!user_id || !item_id || !content_type) {
          return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields" }) };
        }

        await usersCollection.updateOne(
          { _id: user_id },
          {
            $unset: { [`ratings.${content_type}.${item_id}`]: "" },
            $set: { updated_at: new Date().toISOString() }
          }
        );

        return { statusCode: 200, body: JSON.stringify({ success: true }) };
      }

      // Add item to list
      case "add_to_list": {
        const { user_id, item_id, list_name, content_type } = body;

        if (!user_id || !item_id || !list_name || !content_type) {
          return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields" }) };
        }

        // Validate list_name for content_type
        const validLists = {
          boardgame: ['wishlist', 'owned', 'want_to_play', 'favorites', 'played'],
          movie: ['watchlist', 'favorites', 'watched'],
          tvshow: ['watchlist', 'favorites', 'watching', 'watched']
        };

        if (!validLists[content_type]?.includes(list_name)) {
          return { statusCode: 400, body: JSON.stringify({ error: `Invalid list_name for ${content_type}` }) };
        }

        // Store metadata about the item for later display
        const itemMetadata = {
          title: body.title || '',
          thumbnail: body.thumbnail || '',
          description: body.description || '',
          added_at: new Date().toISOString()
        };

        await usersCollection.updateOne(
          { _id: user_id },
          {
            $addToSet: { [`lists.${content_type}.${list_name}`]: String(item_id) },
            $set: { 
              [`item_metadata.${content_type}.${item_id}`]: itemMetadata,
              updated_at: new Date().toISOString()
            }
          },
          { upsert: true }
        );

        return { statusCode: 200, body: JSON.stringify({ success: true, metadata: itemMetadata }) };
      }

      // Remove item from list
      case "remove_from_list": {
        const { user_id, item_id, list_name, content_type } = body;

        if (!user_id || !item_id || !list_name || !content_type) {
          return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields" }) };
        }

        await usersCollection.updateOne(
          { _id: user_id },
          {
            $pull: { [`lists.${content_type}.${list_name}`]: String(item_id) },
            $set: { updated_at: new Date().toISOString() }
          }
        );

        return { statusCode: 200, body: JSON.stringify({ success: true }) };
      }

      // Discover content from similar users
      case "discover_from_similar_users": {
        const userId = qs.user_id;
        const contentType = qs.content_type || 'movie'; // movie, tvshow, or boardgame
        const limit = parseInt(qs.limit) || 10;

        if (!userId) {
          return { statusCode: 400, body: JSON.stringify({ error: "Missing user_id" }) };
        }

        // Get current user's data
        const currentUser = await usersCollection.findOne({ _id: userId });
        if (!currentUser || !currentUser.$vector) {
          return {
            statusCode: 404,
            body: JSON.stringify({
              error: "User not found or taste profile not generated. Rate some content first!"
            })
          };
        }

        // Find similar users using vector similarity
        const similarUsers = await usersCollection.find(
          { _id: { $ne: userId } },  // Exclude current user
          {
            sort: { $vector: currentUser.$vector },
            limit: 20,  // Get top 20 similar users
            includeSimilarity: true,
            projection: {
              _id: 1,
              username: 1,
              [`ratings.${contentType}`]: 1,
              $similarity: 1
            }
          }
        ).toArray();

        // Get items rated highly by similar users that current user hasn't rated
        const currentUserRatings = currentUser.ratings?.[contentType] || {};
        const recommendations = [];
        const itemScores = {}; // itemId -> { totalScore, count, avgRating }

        for (const simUser of similarUsers) {
          const similarity = simUser.$similarity || 0;
          const theirRatings = simUser.ratings?.[contentType] || {};

          for (const [itemId, ratingData] of Object.entries(theirRatings)) {
            // Skip if current user already rated this
            if (currentUserRatings[itemId]) continue;

            // Only recommend highly-rated items (>= 7.0)
            if (ratingData.rating < 7.0) continue;

            if (!itemScores[itemId]) {
              itemScores[itemId] = {
                itemId,
                title: ratingData.title || ratingData.name,
                genres: ratingData.genres || [],
                year: ratingData.year,
                totalScore: 0,
                count: 0,
                ratings: [],
                similarUsers: []
              };
            }

            // Weight rating by user similarity
            const weightedScore = ratingData.rating * similarity;
            itemScores[itemId].totalScore += weightedScore;
            itemScores[itemId].count += 1;
            itemScores[itemId].ratings.push(ratingData.rating);
            itemScores[itemId].similarUsers.push({
              username: simUser.username,
              rating: ratingData.rating,
              similarity: similarity.toFixed(3)
            });
          }
        }

        // Convert to array and calculate final scores
        const rankedItems = Object.values(itemScores).map(item => ({
          ...item,
          score: item.totalScore / item.count,  // Weighted average
          avgRating: item.ratings.reduce((a, b) => a + b, 0) / item.ratings.length,
          ratedBy: item.count
        }));

        // Sort by score (similarity-weighted rating) descending
        rankedItems.sort((a, b) => b.score - a.score);

        return {
          statusCode: 200,
          body: JSON.stringify({
            user_id: userId,
            content_type: contentType,
            similar_users_checked: similarUsers.length,
            recommendations: rankedItems.slice(0, limit).map(item => ({
              itemId: item.itemId,
              title: item.title,
              genres: item.genres,
              year: item.year,
              score: item.score.toFixed(2),
              avgRating: item.avgRating.toFixed(1),
              ratedBy: item.ratedBy,
              topSimilarUsers: item.similarUsers.slice(0, 3)  // Show top 3 similar users who rated it
            }))
          })
        };
      }

      default:
        return { statusCode: 400, body: JSON.stringify({ error: "Invalid action" }) };
    }
  } catch (error) {
    console.error("User Data Error:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
}
