"use strict";
/* =========================================================================
   Firebase configuration — FILL IN ONCE before pushing to GitHub.

   Uses Firebase's Realtime Database here, via its REST API (no need
   for the full SDK): simple fetch() requests to your
   databaseURL are enough to read/write levels as JSON.

   - databaseURL: the URL of your Realtime Database, something like
     "https://YOUR-PROJECT-default-rtdb.firebaseio.com" (no trailing slash).
   - authToken: optional. Leave empty if your security rules
     allow public read/write (handy for testing, but should be
     locked down before a real production deployment). Otherwise, put a
     database secret or a Firebase auth token here.

   These are the only values used — there is no in-app settings screen to
   override them; edit this file directly and redeploy to change them. */
const FIREBASE_CONFIG = {
  databaseURL: "https://downfall-e1bec-default-rtdb.firebaseio.com",
  authToken: "",
};
