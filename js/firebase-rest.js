"use strict";
/* =========================================================================
   Firebase — petite couche REST partagée par l'éditeur et le jeu.
   Utilise l'API REST de la Realtime Database (de simples fetch(), pas de
   SDK) : chaque niveau est stocké sous /levels/{id}.json, avec un champ
   "status" ("PRODUCTION" ou "FINAL") qui détermine si le jeu doit le
   proposer aux joueurs.
   ========================================================================= */

const FIREBASE_SETTINGS_KEY = "chutelibre_firebase_settings_v1";

/* Les réglages effectifs = ceux enregistrés en local (localStorage) s'il y
   en a, sinon les valeurs par défaut du fichier firebase-config.js — ainsi
   l'utilisateur peut tester avec d'autres identifiants sans toucher au
   fichier livré avec le site. */
function getFirebaseSettings(){
  try{
    const raw = localStorage.getItem(FIREBASE_SETTINGS_KEY);
    if(raw){
      const saved = JSON.parse(raw);
      return {
        databaseURL: saved.databaseURL || (typeof FIREBASE_CONFIG!=="undefined" ? FIREBASE_CONFIG.databaseURL : "") || "",
        authToken: saved.authToken || (typeof FIREBASE_CONFIG!=="undefined" ? FIREBASE_CONFIG.authToken : "") || "",
      };
    }
  }catch(e){}
  return {
    databaseURL: (typeof FIREBASE_CONFIG!=="undefined" ? FIREBASE_CONFIG.databaseURL : "") || "",
    authToken: (typeof FIREBASE_CONFIG!=="undefined" ? FIREBASE_CONFIG.authToken : "") || "",
  };
}
function saveFirebaseSettings(settings){
  try{ localStorage.setItem(FIREBASE_SETTINGS_KEY, JSON.stringify(settings)); }catch(e){}
}

function firebaseUrl(path, settings){
  const s = settings || getFirebaseSettings();
  const base = (s.databaseURL||"").replace(/\/+$/,"");
  let url = base + path + ".json";
  if(s.authToken) url += "?auth=" + encodeURIComponent(s.authToken);
  return url;
}

/* Liste tous les niveaux stockés (objet {id: {...niveau, status, updatedAt}}). */
async function firebaseListLevels(settings){
  const s = settings || getFirebaseSettings();
  if(!s.databaseURL) throw new Error("Aucune base de données configurée (onglet Paramètres).");
  const res = await fetch(firebaseUrl("/levels", s));
  if(!res.ok) throw new Error("Erreur Firebase (" + res.status + ")");
  const data = await res.json();
  return data || {};
}

/* Sauvegarde (crée ou remplace) un niveau, avec son statut. */
async function firebaseSaveLevel(level, status, settings){
  const s = settings || getFirebaseSettings();
  if(!s.databaseURL) throw new Error("Aucune base de données configurée (onglet Paramètres).");
  if(!level.id) throw new Error("Le niveau doit avoir un identifiant.");
  const payload = Object.assign({}, level, { status: status, updatedAt: Date.now() });
  const res = await fetch(firebaseUrl("/levels/" + encodeURIComponent(level.id), s), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if(!res.ok) throw new Error("Erreur Firebase (" + res.status + ")");
  return payload;
}

/* Charge un seul niveau par id. */
async function firebaseLoadLevel(id, settings){
  const s = settings || getFirebaseSettings();
  if(!s.databaseURL) throw new Error("Aucune base de données configurée (onglet Paramètres).");
  const res = await fetch(firebaseUrl("/levels/" + encodeURIComponent(id), s));
  if(!res.ok) throw new Error("Erreur Firebase (" + res.status + ")");
  const data = await res.json();
  if(!data) throw new Error("Niveau introuvable.");
  return data;
}
