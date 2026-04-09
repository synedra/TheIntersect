#!/usr/bin/env python3
"""
Debug script to test TV show search functionality
Tests why "Pluribus" returns no results via the backend API
"""

import requests
import json

# Backend API endpoint
API_URL = "https://movie-key-app.netlify.app/.netlify/functions/astra"

def test_tv_search(query="Pluribus"):
    """Test TV show search via backend API"""
    
    print(f"\n{'='*60}")
    print(f"Testing TV Show Search: '{query}'")
    print(f"{'='*60}\n")
    
    # Test 1: Search with query parameter
    print("TEST 1: Search with query parameter (tvshows)")
    print("-" * 40)
    params = {
        "action": "search",
        "query": query,
        "content_types": "tvshows"
    }
    print(f"Parameters: {json.dumps(params, indent=2)}")
    
    try:
        response = requests.get(API_URL, params=params, timeout=10)
        print(f"Status Code: {response.status_code}")
        data = response.json()
        print(f"Response: {json.dumps(data, indent=2)}")
    except Exception as e:
        print(f"ERROR: {e}")
    
    # Test 2: Discover TV shows (no query)
    print("\n\nTEST 2: Discover TV shows (first 5 results)")
    print("-" * 40)
    params = {
        "action": "discover",
        "content_types": "tvshows",
        "limit": "5"
    }
    print(f"Parameters: {json.dumps(params, indent=2)}")
    
    try:
        response = requests.get(API_URL, params=params, timeout=10)
        print(f"Status Code: {response.status_code}")
        data = response.json()
        if isinstance(data, dict) and "results" in data:
            print(f"Found {len(data.get('results', []))} results")
            if data.get('results'):
                print(f"Sample: {json.dumps(data['results'][0], indent=2)}")
        else:
            print(f"Response: {json.dumps(data, indent=2)}")
    except Exception as e:
        print(f"ERROR: {e}")
    
    # Test 3: Search for movies to compare
    print("\n\nTEST 3: Search for movies (known good result)")
    print("-" * 40)
    params = {
        "action": "search",
        "query": "Inception",
        "content_types": "movies"
    }
    print(f"Parameters: {json.dumps(params, indent=2)}")
    
    try:
        response = requests.get(API_URL, params=params, timeout=10)
        print(f"Status Code: {response.status_code}")
        data = response.json()
        if isinstance(data, dict) and "results" in data:
            print(f"Found {len(data.get('results', []))} results")
            if data.get('results'):
                print(f"Sample: {json.dumps(data['results'][0], indent=2)}")
        else:
            print(f"Response: {json.dumps(data, indent=2)}")
    except Exception as e:
        print(f"ERROR: {e}")
    
    # Test 4: Search for Pluribus with different parameter combinations
    print("\n\nTEST 4: Pluribus with different content_types values")
    print("-" * 40)
    
    content_type_variants = ["tvshows", "tv", "television", "shows"]
    for content_type in content_type_variants:
        print(f"\nTrying content_types='{content_type}'")
        params = {
            "action": "search",
            "query": "Pluribus",
            "content_types": content_type
        }
        
        try:
            response = requests.get(API_URL, params=params, timeout=10)
            print(f"  Status: {response.status_code}")
            data = response.json()
            if isinstance(data, dict) and "results" in data:
                print(f"  Results: {len(data.get('results', []))} found")
            else:
                print(f"  Data: {json.dumps(data, indent=2)}")
        except Exception as e:
            print(f"  ERROR: {e}")

if __name__ == "__main__":
    test_tv_search()
