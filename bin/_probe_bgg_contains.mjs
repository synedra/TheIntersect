import { DataAPIClient } from '@datastax/astra-db-ts';
import dotenv from 'dotenv';

dotenv.config({ override: true });
const client = new DataAPIClient(process.env.ASTRA_DB_APPLICATION_TOKEN);
const db = client.db(process.env.ASTRA_DB_API_ENDPOINT, { keyspace: process.env.ASTRA_BOARDGAME_KEYSPACE || 'boardgames' });
const coll = db.collection('bgg_board_games');

const query = {
  $or: [
    { name: { $contains: 'Lord of the Rings' } },
    { name0: { $contains: 'Lord of the Rings' } }
  ]
};

const rows = await coll.find(query, {
  limit: 6,
  projection: { name: 1, name0: 1, bggid: 1, boardgamerank: 1 }
}).toArray();

console.log(JSON.stringify(rows, null, 2));
