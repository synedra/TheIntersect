async function loadAutocompleteData() {
  try {
    const response = await fetch('/public/autocomplete.json');
    
    if (!response.ok) {
      console.error(`Failed to fetch autocomplete data: ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Failed to load autocomplete data:', error);
    return [];
  }
}
