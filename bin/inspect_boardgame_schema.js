import dotenv from 'dotenv';
import { DataAPIClient } from '@datastax/astra-db-ts';

dotenv.config({ override: true });

async function run() {
  const client = new DataAPIClient(process.env.ASTRA_DB_APPLICATION_TOKEN);
  const keyspace = process.env.ASTRA_BOARDGAME_KEYSPACE || 'boardgames';
  const db = client.db(process.env.ASTRA_DB_API_ENDPOINT, { keyspace });
  const coll = db.collection('bgg_board_games');

  const sample = await coll.find({}, { limit: 3 }).toArray();
  console.log('sample keys:', Object.keys(sample[0] || {}).slice(0, 60));
  console.log('sample category/mechanic fields:', sample.map((s) => ({
    id: s._id,
    category0: s.category0,
    category1: s.category1,
    categories: s.categories,
    boardgamecategory: s.boardgamecategory,
    mechanic0: s.mechanic0,
    mechanic1: s.mechanic1,
    mechanics: s.mechanics,
    boardgamemechanic: s.boardgamemechanic,
  })));

  const adventureCat0 = await coll.find({ category0: 'Adventure' }, { limit: 5 }).toArray();
  console.log('category0=Adventure sample count:', adventureCat0.length);

  const adventureOr = await coll
    .find({
      $or: [
        { category0: 'Adventure' },
        { category1: 'Adventure' },
        { category2: 'Adventure' },
      ],
    }, { limit: 5 })
    .toArray();
  console.log('OR category0..2=Adventure sample count:', adventureOr.length);

  const categoriesIn = await coll.find({ categories: { $in: ['Adventure'] } }, { limit: 5 }).toArray();
  console.log('categories $in Adventure sample count:', categoriesIn.length);

  const boardgameCategoryIn = await coll.find({ boardgamecategory: { $in: ['Adventure'] } }, { limit: 5 }).toArray();
  console.log('boardgamecategory $in Adventure sample count:', boardgameCategoryIn.length);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
