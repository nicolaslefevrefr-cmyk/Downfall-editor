# Éditeur de niveaux — Chute Libre

Éditeur visuel pour composer des niveaux de *Chute Libre* : poser des blocs depuis une bibliothèque, les paramétrer (position, taille, trigger, action, description), les relier entre eux (cascades), tester immédiatement le niveau avec le vrai moteur physique du jeu, puis exporter le tout en JSON.

## Utilisation rapide

- **Poser un objet** : clique un élément de la bibliothèque (à gauche) puis clique sur la scène.
- **Sélectionner / déplacer** : clique un objet, fais-le glisser. La poignée bleue en bas à droite redimensionne.
- **Paramétrer** : le panneau de droite affiche position, taille, description, déclencheur (trigger), action, et les cascades (`then`).
- **Relier deux objets** : dans le panneau de droite, bouton "🔗 Lier →", puis clique l'objet cible sur la scène. Une flèche rouge apparaît, avec le délai éditable.
- **Déclencheurs indépendants** : l'objet "Déclencheur (zone invisible)" de la bibliothèque pose une zone de trigger pure, sans apparence dans le jeu — à relier à un autre bloc (ex. un mur qui surgit) pour reproduire le piège du "plafond menteur".
- **Tester** : bouton "▶ Tester le niveau" en haut à droite. Flèches/QD + Espace, ou les boutons tactiles en bas. "■ Retour à l'édition" pour revenir.
- **Exporter / Importer** : boutons dédiés dans la barre du haut. Le fichier JSON exporté a la forme `{ levels: [ {id, name, difficulty, playerStart, exit, objects:[...]} ] }`, directement compatible avec le format `LEVELS_SOURCE` du jeu.

## Limites connues

- Pas d'annuler/rétablir (Ctrl+Z) pour l'instant.
- Une seule sélection à la fois (pas de sélection multiple).
- Le mode Test est volontairement une réimplémentation fidèle mais séparée du moteur du jeu ; en cas de doute sur un comportement fin, retester dans le jeu lui-même reste la référence.

## Déployer sur GitHub Pages

Pousser le contenu de ce dossier (`index.html` à la racine) sur un dépôt GitHub, puis activer **Settings → Pages → Deploy from branch**. L'installation PWA nécessite HTTPS (fourni par GitHub Pages).
