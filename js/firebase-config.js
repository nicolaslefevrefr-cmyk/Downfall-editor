"use strict";
/* =========================================================================
   Configuration Firebase — À REMPLIR UNE FOIS avant de pousser sur GitHub.

   Utilise ici la Realtime Database de Firebase, via son API REST (pas
   besoin du SDK complet) : de simples requêtes fetch() vers ton
   databaseURL suffisent pour lire/écrire des niveaux en JSON.

   - databaseURL : l'URL de ta Realtime Database, du genre
     "https://TON-PROJET-default-rtdb.firebaseio.com" (sans slash final).
   - authToken : optionnel. Laisse vide si tes règles de sécurité
     autorisent la lecture/écriture publique (pratique pour tester, mais à
     verrouiller avant une mise en production réelle). Sinon, mets ici un
     secret de base de données ou un jeton d'authentification Firebase.

   Ces valeurs ne sont que les valeurs PAR DÉFAUT : l'utilisateur peut les
   remplacer à tout moment depuis l'onglet "Paramètres" de la fenêtre
   Firebase (☁), et sa saisie est alors mémorisée dans le navigateur
   (localStorage) — pratique pour tester avec un autre projet sans modifier
   ce fichier. Ce fichier reste la config "de base" livrée avec le site. */
const FIREBASE_CONFIG = {
  databaseURL: "https://downfall-e1bec-default-rtdb.firebaseio.com",
  authToken: "",
};
