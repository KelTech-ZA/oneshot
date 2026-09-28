// Deployment configuration for the OneShot mail assistant.
//
// Loaded before taskpane.js. Both values are public by nature: the anon key is
// already in the web bundle and authorises nothing on its own (the user's own
// session does that), and an Entra client id is a public identifier.

// Copy from Supabase → Project Settings → API → anon public.
window.__ONESHOT_ANON__ = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50Y3Z3b3N5cGNud2VkeGVmd2NyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ3MzI0ODEsImV4cCI6MjEwMDMwODQ4MX0.rFgFqxMpN6DaE3H74Pw74nTBUuNLdHUHECkyfKZ_Dz4";

// Leave blank until you register the add-in in Entra. While it is blank the
// inbox scan is simply absent and everything else works — which is how the
// first demo runs without waiting on an app registration.
window.__ONESHOT_ENTRA_CLIENT_ID__ = "";
