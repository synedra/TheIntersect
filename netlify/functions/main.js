const NETLIFY_FUNCTIONS_URL = '/.netlify/functions';

async function callAstraAPI(action, id, limit = 10) {
  try {
    const url = `${NETLIFY_FUNCTIONS_URL}/astra?action=${action}&id=${encodeURIComponent(id)}&limit=${limit}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error calling astra API:', error);
    throw error;
  }
}

async function loadAutocompleteData() {
  try {
    const response = await fetch('/data/autocomplete.json');
    
    if (!response.ok) {
      console.error(`Failed to fetch autocomplete data: ${response.status}`);
      return [];
    }
    
    // First get as text to check what we're receiving
    const text = await response.text();
    console.log('Autocomplete data received:', text.substring(0, 100));
    
    // Try to parse the JSON
    try {
      const data = JSON.parse(text);
      return Array.isArray(data) ? data : [];
    } catch (parseError) {
      console.error('JSON parse error:', parseError);
      console.error('Raw text:', text);
      return [];
    }
  } catch (error) {
    console.error('Failed to load autocomplete data:', error);
    return [];
  }
}

// Initialize the application
async function init() {
  try {
    const autocompleteData = await loadAutocompleteData();
    // Initialize autocomplete with the loaded data
    setupAutocomplete(autocompleteData);
  } catch (error) {
    console.error('Initialization error:', error);
  }
}

function setupAutocomplete(data) {
  // Your autocomplete setup code here
}

// Call init when DOM is ready
document.addEventListener('DOMContentLoaded', init);
