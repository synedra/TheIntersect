require('dotenv').config();
const { DataAPIClient } = require('@datastax/astra-db-ts');
const fs = require('fs');
const path = require('path');

const MOVIE_COLLECTION = 'movies2026';
const TV_COLLECTION = 'tvshows2026';
const JSON_FILE_PATH = path.join(__dirname, '../database_upload.json');

async function loadData() {
    const { ASTRA_DB_APPLICATION_TOKEN, ASTRA_DB_API_ENDPOINT } = process.env;

    if (!ASTRA_DB_APPLICATION_TOKEN || !ASTRA_DB_API_ENDPOINT) {
        console.error('Error: ASTRA_DB_APPLICATION_TOKEN and ASTRA_DB_API_ENDPOINT are required in .env');
        process.exit(1);
    }

    const client = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN);
    const db = client.db(ASTRA_DB_API_ENDPOINT);

    console.log(`Connecting to Astra DB...`);
    
    // Helper to ensure collection exists
    const ensureCollection = async (name) => {
        try {
            const collections = await db.listCollections();
            if (!collections.some(c => c.name === name)) {
                console.log(`Creating collection '${name}'...`);
                await db.createCollection(name, {
                    vector: {
                        dimension: 1536, // Open AI dimension
                        metric: 'cosine'
                    }
                });
            }
        } catch (e) {
            console.error(`Error checking/creating collection ${name}:`, e.message);
        }
    };

    await ensureCollection(MOVIE_COLLECTION);
    await ensureCollection(TV_COLLECTION);

    const movieCollection = db.collection(MOVIE_COLLECTION);
    const tvCollection = db.collection(TV_COLLECTION);

    console.log(`Reading data from ${JSON_FILE_PATH}...`);
    let data;
    try {
        const raw = fs.readFileSync(JSON_FILE_PATH);
        data = JSON.parse(raw);
    } catch (e) {
        console.error("Error reading JSON file:", e.message);
        process.exit(1);
    }

    // Split data by type
    const movies = data.filter(item => item.type === 'movie');
    const tvShows = data.filter(item => item.type === 'tv');

    console.log(`Found ${movies.length} movies and ${tvShows.length} TV shows. Uploading...`);

    // Helper for batch upload
    const uploadBatch = async (collection, items, label) => {
        const BATCH_SIZE = 20;
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
            const batch = items.slice(i, i + BATCH_SIZE);
            try {
                await collection.insertMany(batch);
                console.log(`[${label}] Uploaded records ${i + 1} to ${Math.min(i + BATCH_SIZE + i, items.length)}`);
            } catch (e) {
                console.error(`[${label}] Error uploading batch starting at ${i}:`, e.message);
            }
        }
    };

    await uploadBatch(movieCollection, movies, 'Movies');
    await uploadBatch(tvCollection, tvShows, 'TV');

    console.log("Upload complete!");
}

loadData();
