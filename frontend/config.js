// Set this to your backend's URL when frontend and backend are hosted on
// DIFFERENT domains (e.g. frontend on Vercel, backend on Render).
// Automatically defaults to http://localhost:4000 when running locally.
const isLocal = typeof window !== 'undefined' && (['localhost', '127.0.0.1'].includes(window.location.hostname) || !window.location.hostname);
window.WORKTRACK_API_BASE = window.WORKTRACK_API_BASE || (isLocal ? 'http://localhost:4000' : 'https://erp-lcd5.onrender.com');
