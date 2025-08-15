import CONFIG from './config.js';

// Simple global for diagnostics
window.API_DIAG = {
  tokenPresent: !!CONFIG.APP_TOKEN,
  origin: location.origin,
  last: null,
};

// Add any additional JavaScript logic here
console.log("App initialized with token:", CONFIG.APP_TOKEN);

// Example: Add event listeners or API calls here
// (Include any additional JavaScript logic from your original code)