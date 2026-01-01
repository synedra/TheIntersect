#!/usr/bin/env python3
"""
Script to inspect watch_providers data structure in Astra DB
"""
import os
import json
from astrapy import DataAPIClient

# Astra DB configuration - you'll need to set these environment variables or edit the values
ASTRA_DB_APPLICATION_TOKEN = os.getenv('ASTRA_DB_APPLICATION_TOKEN', 'your-astra-token-here')
ASTRA_DB_API_ENDPOINT = os.getenv('ASTRA_DB_API_ENDPOINT', 'your-astra-endpoint-here')
COLLECTION_NAME = "movies2026"

def inspect_watch_providers():
    """Inspect the watch_providers field structure in the database"""

    if ASTRA_DB_APPLICATION_TOKEN == 'your-astra-token-here':
        print("❌ Please set your ASTRA_DB_APPLICATION_TOKEN environment variable or edit this script")
        print("   You can find your token in the Astra DB dashboard under 'Connect' > 'Application Tokens'")
        return

    if ASTRA_DB_API_ENDPOINT == 'your-astra-endpoint-here':
        print("❌ Please set your ASTRA_DB_API_ENDPOINT environment variable or edit this script")
        print("   You can find your endpoint in the Astra DB dashboard under 'Connect' > 'Database Details'")
        return

    try:
        # Connect to Astra
        client = DataAPIClient(ASTRA_DB_APPLICATION_TOKEN)
        db = client.get_database_by_api_endpoint(ASTRA_DB_API_ENDPOINT)
        collection = db.get_collection(COLLECTION_NAME)

        print("🔍 Inspecting watch_providers data structure...")

        # Find movies with watch_providers
        movies_with_providers = list(collection.find(
            {"watch_providers": {"$exists": True}},
            limit=10
        ))

        if not movies_with_providers:
            print("❌ No movies found with watch_providers field")
            return

        print(f"✅ Found {len(movies_with_providers)} movies with watch_providers")

        # Analyze the structure
        all_providers = set()
        provider_counts = {}

        for movie in movies_with_providers:
            wp = movie.get('watch_providers', {})
            if 'US' in wp:
                us_providers = wp['US']
                if 'stream' in us_providers:
                    for provider in us_providers['stream']:
                        all_providers.add(provider)
                        provider_counts[provider] = provider_counts.get(provider, 0) + 1

        print("\n📊 Streaming providers found in US region:")
        for provider in sorted(all_providers):
            count = provider_counts[provider]
            print(f"   {provider}: {count} movies")

        print(f"\n📋 Total unique providers: {len(all_providers)}")

        # Show a sample movie's watch_providers structure
        sample_movie = movies_with_providers[0]
        print("\n🔍 Sample movie watch_providers structure:")
        print(json.dumps(sample_movie.get('watch_providers', {}), indent=2))

        # Test a specific provider query
        test_provider = "Netflix"
        print(f"\n🧪 Testing query for '{test_provider}'...")

        netflix_movies = list(collection.find({
            "watch_providers.US.stream": {"$in": [test_provider]}
        }, limit=5))

        print(f"   Found {len(netflix_movies)} movies with {test_provider}")
        if netflix_movies:
            for movie in netflix_movies[:3]:
                print(f"   - {movie.get('title', 'Unknown title')}")

    except Exception as e:
        print(f"❌ Error: {e}")
        print("\n💡 Make sure your Astra DB credentials are correct and the collection exists.")

if __name__ == "__main__":
    inspect_watch_providers()