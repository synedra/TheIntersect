import dotenv from 'dotenv';
import { handler } from '../netlify/functions/astra.js';

dotenv.config({ override: true });

async function run() {
  const event = {
    queryStringParameters: {
      action: 'search',
      content_types: 'boardgames',
      genre: 'Adventure',
      limit: '20'
    }
  };

  const res = await handler(event);
  const body = JSON.parse(res.body || '{}');
  console.log('statusCode:', res.statusCode);
  console.log('result count:', (body.results || []).length);
  const sample = (body.results || []).slice(0, 5).map((r) => ({
    id: r._id,
    name: r.name,
    categories: r.categories,
    category0: r.category0
  }));
  console.log('sample:', sample);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
