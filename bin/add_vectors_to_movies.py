#!/usr/bin/env python3
"""
Add vector embeddings to movies that are missing them.
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


def create_embedding_text(movie_doc):
    """Create a text representation for embedding."""
    parts = []
    
    # Title and overview
    if movie_doc.get('title'):
        parts.append(f"Title: {movie_doc['title']}")
    if movie_doc.get('tagline'):
        parts.append(f"Tagline: {movie_doc['tagline']}")
    if movie_doc.get('overview'):
        parts.append(f"Overview: {movie_doc['overview']}")
    
    # Genres
    if movie_doc.get('genres'):
        parts.append(f"Genres: {', '.join(movie_doc['genres'])}")
    
    # Cast (top 10)
    if movie_doc.get('cast'):
        parts.append(f"Cast: {', '.join(movie_doc['cast'][:10])}")
    
    # Directors
    if movie_doc.get('directors'):
        parts.append(f"Directors: {', '.join(movie_doc['directors'])}")
    
    # Keywords
    if movie_doc.get('keywords'):
        parts.append(f"Keywords: {', '.join(movie_doc['keywords'][:10])}")
    
    return " | ".join(parts)


def generate_embedding(text):
    """Generate embedding using OpenAI."""
    response = openai_client.embeddings.create(
        model=EMBEDDING_MODEL,
        input=text
    )
    return response.data[0].embedding


def main():
    collection = database.get_collection("movies2026")
    
    # Find all movies - include $vector in projection to check if it exists
    print("Counting movies...")
    all_movies = list(collection.find({}, projection={"_id": 1, "title": 1, "overview": 1, "genres": 1, "cast": 1, "directors": 1, "keywords": 1, "tagline": 1, "$vector": 1}))
    
    print(f"Found {len(all_movies)} movies")
    
    # Filter those without vectors
    movies_without_vectors = [m for m in all_movies if '$vector' not in m]
    
    print(f"{len(movies_without_vectors)} movies are missing vector embeddings")
    
    if len(movies_without_vectors) == 0:
        print("All movies already have embeddings!")
        return
    
    # Process each movie
    success = 0
    errors = 0
    
    for movie in tqdm(movies_without_vectors, desc="Adding embeddings"):
        try:
            # Create embedding text
            embedding_text = create_embedding_text(movie)
            
            # Generate embedding
            embedding = generate_embedding(embedding_text)
            
            # Update the document with $vector field
            collection.update_one(
                {"_id": movie["_id"]},
                {"$set": {"$vector": embedding}}
            )
            
            success += 1
        except Exception as e:
            errors += 1
            print(f"\n⚠️  Error processing {movie.get('title', movie['_id'])}: {e}")
    
    print(f"\n✅ Successfully added embeddings to {success} movies")
    if errors > 0:
        print(f"⚠️  Failed to process {errors} movies")


if __name__ == "__main__":
    main()
