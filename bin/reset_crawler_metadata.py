import os
from dotenv import load_dotenv
from astrapy import DataAPIClient

# Load environment variables
load_dotenv()

ASTRA_DB_API_ENDPOINT = os.getenv("ASTRA_DB_API_ENDPOINT")
ASTRA_DB_APPLICATION_TOKEN = os.getenv("ASTRA_DB_APPLICATION_TOKEN")

# Validate environment variables
if not ASTRA_DB_API_ENDPOINT:
    raise ValueError("ASTRA_DB_API_ENDPOINT not found in .env file")
if not ASTRA_DB_APPLICATION_TOKEN:
    raise ValueError("ASTRA_DB_APPLICATION_TOKEN not found in .env file")

def reset_metadata_collection():
    print("="*80)
    print("Reset crawler_metadata_2026_filtered Collection")
    print("="*80)
    
    response = input("\n⚠️  This will DELETE and recreate the crawler_metadata_2026_filtered collection. Continue? (yes/no): ")
    if response.lower() not in ('yes', 'y'):
        print("Cancelled.")
        return
    
    print("\nConnecting to Astra DB...")
    client = DataAPIClient(ASTRA_DB_APPLICATION_TOKEN)
    database = client.get_database(ASTRA_DB_API_ENDPOINT)
    
    # Delete the collection if it exists
    try:
        database.drop_collection("crawler_metadata_2026_filtered")
        print("✅ Deleted existing crawler_metadata_2026_filtered collection")
    except Exception as e:
        print(f"⚠️  Collection may not exist: {e}")
    
    # Recreate the collection
    try:
        database.create_collection("crawler_metadata_2026_filtered")
        print("✅ Created new crawler_metadata_2026_filtered collection")
    except Exception as e:
        print(f"❌ Error creating collection: {e}")
        return
    
    print("\n" + "="*80)
    print("✅ Reset complete!")
    print("="*80)

if __name__ == "__main__":
    reset_metadata_collection()