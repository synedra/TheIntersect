// Remove the direct file loading - use the API instead
async function getAutocompleteSuggestions(query) {
  if (!query || query.length < 2) {
    return [];
  }
  
  try {
    const response = await fetch(`/.netlify/functions/astra?action=autocomplete&query=${encodeURIComponent(query)}`);
    
    if (!response.ok) {
      console.error(`Autocomplete API error: ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    return data.results || [];
  } catch (error) {
    console.error('Autocomplete failed:', error);
    return [];
  }
}

// If you have an autocomplete input, attach it like this:
const searchInput = document.querySelector('#search-input');
if (searchInput) {
  let timeout;
  searchInput.addEventListener('input', async (e) => {
    clearTimeout(timeout);
    const query = e.target.value;
    
    timeout = setTimeout(async () => {
      const suggestions = await getAutocompleteSuggestions(query);
      // Display suggestions in your UI
      displaySuggestions(suggestions);
    }, 300);
  });
}

function displaySuggestions(suggestions) {
  // Your UI code to show the autocomplete suggestions
  console.log('Suggestions:', suggestions);
}
