"use strict";
/* =========================================================================
   Firebase — small REST layer shared by the editor and the game.
   Uses the Realtime Database's REST API (plain fetch(), no
   SDK): each level is stored under /levels/{id}.json, with a
   "status" field ("PRODUCTION" or "FINAL") that determines whether the game should
   proposer aux joueurs.
   ========================================================================= */

/* Connection settings come only from js/firebase-config.js —
   pas de surcouche modifiable depuis l'interface. Pour changer de base, on
   edit this file directly before deploying. */
function getFirebaseSettings(){
  return {
    databaseURL: (typeof FIREBASE_CONFIG!=="undefined" ? FIREBASE_CONFIG.databaseURL : "") || "",
    authToken: (typeof FIREBASE_CONFIG!=="undefined" ? FIREBASE_CONFIG.authToken : "") || "",
  };
}

function firebaseUrl(path, settings){
  const s = settings || getFirebaseSettings();
  const base = (s.databaseURL||"").replace(/\/+$/,"");
  let url = base + path + ".json";
  if(s.authToken) url += "?auth=" + encodeURIComponent(s.authToken);
  return url;
}

/* Lists all stored levels (object {id: {...level, status, updatedAt}}). */
async function firebaseListLevels(settings){
  const s = settings || getFirebaseSettings();
  if(!s.databaseURL) throw new Error("No database configured (see js/firebase-config.js).");
  const res = await fetch(firebaseUrl("/levels", s));
  if(!res.ok) throw new Error("Firebase error (" + res.status + ")");
  const data = await res.json();
  return data || {};
}

/* Saves (creates or replaces) a level, with its status. */
async function firebaseSaveLevel(level, status, settings){
  const s = settings || getFirebaseSettings();
  if(!s.databaseURL) throw new Error("No database configured (see js/firebase-config.js).");
  if(!level.id) throw new Error("The level must have an identifier.");
  const payload = Object.assign({}, level, { status: status, updatedAt: Date.now() });
  const res = await fetch(firebaseUrl("/levels/" + encodeURIComponent(level.id), s), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if(!res.ok) throw new Error("Firebase error (" + res.status + ")");
  return payload;
}

/* Loads a single level by id. */
async function firebaseLoadLevel(id, settings){
  const s = settings || getFirebaseSettings();
  if(!s.databaseURL) throw new Error("No database configured (see js/firebase-config.js).");
  const res = await fetch(firebaseUrl("/levels/" + encodeURIComponent(id), s));
  if(!res.ok) throw new Error("Firebase error (" + res.status + ")");
  const data = await res.json();
  if(!data) throw new Error("Level not found.");
  return data;
}

/* Deletes a level. */
async function firebaseDeleteLevel(id, settings){
  const s = settings || getFirebaseSettings();
  if(!s.databaseURL) throw new Error("No database configured (see js/firebase-config.js).");
  const res = await fetch(firebaseUrl("/levels/" + encodeURIComponent(id), s), { method: "DELETE" });
  if(!res.ok) throw new Error("Firebase error (" + res.status + ")");
}
