#!/usr/bin/env python3
"""
Add vector embeddings to TV shows that are missing them.
"""

import os
import sys
from dotenv import load_dotenv
from astrapy import DataAPIClient
from openai import OpenAI
from tqdm import tqdm

load_dotenv()

# Check environment variables
ASTRA_DB_APPLICATION_TOKEN = os.getenv("ASTRA_DB_APPLICATION_TOKEN")
ASTRA_DB_API_ENDPOINT = os.getenv("ASTRA_DB_API_ENDPOINT")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

if not all([ASTRA_DB_APPLICATION_TOKEN, ASTRA_DB_API_ENDPOINT, OPENAI_API_KEY]):
    raise ValueError("Missing required environment variables")

# Initialize clients
astra_client = DataAPIClient(ASTRA_DB_APPLICATION_TOKEN)
database = astra_client.get_database(ASTRA_DB_API_ENDPOINT)
openai_client = OpenAI(api_key=OPENAI_API_KEY)

EMBEDDING_MODEL = "text-embedding-3-small"


def create_embedding_text(tv_doc):
    """Create a text representation for embedding."""
    parts = []
    
    # Name and overview
    if tv_doc.get('name'):
        parts.append(f"Title: {tv_doc['name']}")
    if tv_doc.get('tagline'):
        parts.append(f"Tagline: {tv_doc['tagline']}")
    if tv_doc.get('overview'):
        parts.append(f"Overview: {tv_doc['overview']}")
    
    # Genres
    if tv_doc.get('genres'):
        parts.append(f"Genres: {', '.join(tv_doc['genres'])}")
    
    # Cast (top 10)
    if tv_doc.get('cast'):
        parts.append(f"Cast: {', '.join(tv_doc['cast'][:10])}")
    
    # Creators
    if tv_doc.get('creators'):
        parts.append(f"Creators: {', '.join(tv_doc['creators'])}")
    
    # Keywords
    if tv_doc.get('keywords'):
        parts.append(f"Keywords: {', '.join(tv_doc['keywords'][:10])}")
    
    return " | ".join(parts)


def generate_embedding(text):
    """Generate embedding using OpenAI."""
    response = openai_client.embeddings.create(
        model=EMBEDDING_MODEL,
        input=text
    )
    return response.data[0].embedding


def main():
    collection = database.get_collection("tvshows2026")
    
    # Find all TV shows - include $vector in projection to check if it exists
    print("Counting TV shows...")
    all_shows = list(collection.find({}, projection={"_id": 1, "name": 1, "overview": 1, "genres": 1, "cast": 1, "creators": 1, "keywords": 1, "tagline": 1, "$vector": 1}))
    
    print(f"Found {len(all_shows)} TV shows")
    
    # Filter those without vectors
    shows_without_vectors = [s for s in all_shows if '$vector' not in s]
    
    print(f"{len(shows_without_vectors)} TV shows are missing vector embeddings")
    
    if len(shows_without_vectors) == 0:
        print("All TV shows already have embeddings!")
        return
    
    # Process each show
    success = 0
    errors = 0
    
    for show in tqdm(shows_without_vectors, desc="Adding embeddings"):
        try:
            # Create embedding text
            embedding_text = create_embedding_text(show)
            
            # Generate embedding
            embedding = generate_embedding(embedding_text)
            
            # Update the document with $vector field
            collection.update_one(
                {"_id": show["_id"]},
                {"$set": {"$vector": embedding}}
            )
            
            success += 1
        except Exception as e:
            errors += 1
            print(f"\n⚠️  Error processing {show.get('name', show['_id'])}: {e}")
    
    print(f"\n✅ Successfully added embeddings to {success} TV shows")
    if errors > 0:
        print(f"⚠️  Failed to process {errors} TV shows")


if __name__ == "__main__":
    main()
