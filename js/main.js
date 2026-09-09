"use strict";
/* =========================================================================
   Chute Libre — interface du jeu, entrées, PWA
   Le rendu (canvas, dessin des objets) vit dans render.js, partagé avec
   l'éditeur. Ce fichier ne s'occupe que du jeu lui-même : HUD, tiroir de
   niveaux, contrôles, overlay de victoire/défaite.
   ========================================================================= */

const overlayEl = document.getElementById("overlay");
const overlayTitle = document.getElementById("overlayTitle");
const overlayText = document.getElementById("overlayText");
const overlayBtn = document.getElementById("overlayBtn");
function showOverlay(title,text,btn){
  overlayTitle.textContent = title; overlayText.textContent = text; overlayBtn.textContent = btn;
  overlayEl.classList.add("show");
}
function hideOverlay(){ overlayEl.classList.remove("show"); }
overlayBtn.addEventListener("click", () => { buildLevel(level); });

const levelNameEl = document.getElementById("levelName");
const levelDiffEl = document.getElementById("levelDiff");
function stars(n){ return "★".repeat(n) + "☆".repeat(5-n); }
function updateHUD(){
  levelNameEl.textContent = level.name;
  levelDiffEl.textContent = stars(level.difficulty);
  renderDrawer();
}

const levelMapNodesEl = document.getElementById("levelMapNodes");
const levelMapPathEl = document.getElementById("levelMapPath");
const levelMapWrapEl = document.getElementById("levelMapWrap");
const statsBlockEl = document.getElementById("statsBlock");
const trapLogEl = document.getElementById("trapLog");

/* Niveaux intégrés dans leur ordre de progression prévu, puis niveaux
   importés/Firebase triés par identifiant (numérique quand c'est possible —
   les identifiants de niveau sont tirés aléatoirement à la création, ce
   qui donne un ordre fixe mais non choisi). */
function orderedLevels(){
  const rest = IMPORTED_LEVELS.concat(FIREBASE_LEVELS).slice().sort((a,b)=>{
    const na = parseInt(a.id,10), nb = parseInt(b.id,10);
    if(!isNaN(na) && !isNaN(nb)) return na-nb;
    return String(a.id).localeCompare(String(b.id));
  });
  return LEVELS_SOURCE.concat(rest);
}

/* Carte "serpentin" : les niveaux sont posés en grille de MAP_COLS colonnes,
   en zigzag (une ligne part de la gauche, la suivante repart de la droite),
   du bas vers le haut — comme une piste de progression. Un trait courbe
   relie les cases dans l'ordre, avec un petit arrondi à chaque virage. */
const MAP_COLS = 3, MAP_NODE = 52, MAP_COLGAP = 96, MAP_ROWGAP = 96, MAP_PAD = 36;
function nodeCenter(i){
  const row = Math.floor(i / MAP_COLS);
  const posInRow = i % MAP_COLS;
  const col = (row % 2 === 0) ? posInRow : (MAP_COLS - 1 - posInRow);
  return { x: MAP_PAD + col*MAP_COLGAP + MAP_NODE/2, rowFromBottom: row };
}
function renderLevelMap(){
  const levels = orderedLevels();
  const n = levels.length;
  const totalRows = Math.max(1, Math.ceil(n / MAP_COLS));
  const contentHeight = MAP_PAD*2 + (totalRows-1)*MAP_ROWGAP + MAP_NODE;
  const contentWidth = MAP_PAD*2 + (MAP_COLS-1)*MAP_COLGAP + MAP_NODE;

  levelMapWrapEl.style.height = Math.min(contentHeight, window.innerHeight*0.52) + "px";
  levelMapNodesEl.style.height = contentHeight + "px";
  levelMapNodesEl.style.width = contentWidth + "px";
  levelMapPathEl.setAttribute("width", contentWidth);
  levelMapPathEl.setAttribute("height", contentHeight);

  const centers = [];
  levelMapNodesEl.innerHTML = "";
  let firstUnlockedTop = null;
  for(let i=0;i<n;i++){
    const lv = levels[i];
    const c = nodeCenter(i);
    const y = contentHeight - MAP_PAD - c.rowFromBottom*MAP_ROWGAP - MAP_NODE/2;
    centers.push({ x:c.x, y });

    const p = progress[lv.id] || {attempts:0, discovered:[], completed:false};
    const unlocked = i===0 || (progress[levels[i-1].id] && progress[levels[i-1].id].completed);
    let state = "locked";
    if(unlocked) state = p.completed ? "completed" : (p.attempts>0 ? "attempted" : "unlocked");

    const node = document.createElement("div");
    node.className = "levelNode " + state + (lv.id===level.id ? " current" : "");
    node.style.left = (c.x - MAP_NODE/2) + "px";
    node.style.top = (y - MAP_NODE/2) + "px";
    node.textContent = state==="locked" ? "🔒" : String(i+1);
    node.title = lv.name + (state==="locked" ? " (verrouillé)" : "");
    if(unlocked){
      node.addEventListener("click", () => { buildLevel(lv); closeDrawer(); });
      if(firstUnlockedTop===null || !p.completed) firstUnlockedTop = y;
    }
    levelMapNodesEl.appendChild(node);
  }

  // Trait courbe reliant les cases dans l'ordre, avec un arrondi à chaque virage.
  let d = "";
  if(centers.length){
    d = "M "+centers[0].x+" "+centers[0].y;
    for(let i=1;i<centers.length-1;i++){
      const mx = (centers[i].x+centers[i+1].x)/2, my = (centers[i].y+centers[i+1].y)/2;
      d += " Q "+centers[i].x+" "+centers[i].y+" "+mx+" "+my;
    }
    if(centers.length>1){ const last=centers[centers.length-1]; d += " L "+last.x+" "+last.y; }
  }
  levelMapPathEl.innerHTML = '<path d="'+d+'" fill="none" stroke="#c7cce0" stroke-width="6" stroke-linecap="round"/>';

  // Fait défiler pour montrer le niveau courant / le prochain à jouer.
  const targetY = (function(){
    const idx = levels.findIndex(lv=>lv.id===level.id);
    return idx>=0 ? centers[idx].y : (firstUnlockedTop||contentHeight);
  })();
  levelMapWrapEl.scrollTop = Math.max(0, targetY - levelMapWrapEl.clientHeight/2);
}

function renderDrawer(){
  renderLevelMap();
  const p = progress[level.id];
  statsBlockEl.innerHTML =
    '<div class="statLine"><span>Tentatives (niveau)</span><span>'+p.attempts+'</span></div>'+
    '<div class="statLine"><span>Pièges découverts</span><span>'+p.discovered.length+'</span></div>'+
    '<div class="statLine"><span>Niveau terminé</span><span>'+(p.completed?"oui":"non")+'</span></div>';
  trapLogEl.innerHTML = "";
  if(!p.discovered.length){
    trapLogEl.innerHTML = '<div class="trapEmpty">Aucun piège découvert pour l\'instant. Meurs une fois pour commencer à comprendre le niveau.</div>';
  } else {
    for(const id of p.discovered){
      const def = level.objects.find(o=>o.id===id);
      if(!def) continue;
      const entry = document.createElement("div");
      entry.className = "trapEntry";
      entry.innerHTML = "<b>"+id+"</b>"+(def.description||"");
      trapLogEl.appendChild(entry);
    }
  }
}

const drawerEl = document.getElementById("drawer");
const drawerBackdrop = document.getElementById("drawerBackdrop");
function openDrawer(){ drawerEl.classList.add("open"); drawerBackdrop.classList.add("show"); renderDrawer(); }
function closeDrawer(){ drawerEl.classList.remove("open"); drawerBackdrop.classList.remove("show"); }
document.getElementById("menuBtn").addEventListener("click", openDrawer);
document.getElementById("closeDrawer").addEventListener("click", closeDrawer);
drawerBackdrop.addEventListener("click", closeDrawer);

/* Hooks appelés par engine.js */
function onLevelBuilt(){ hideOverlay(); updateHUD(); }
function onGameOver(result){
  if(result === "dead"){
    showOverlay("💀 Perdu", lastCause, "Réessayer");
  } else {
    showOverlay("⭐ Niveau terminé", "Réussi en " + progress[level.id].attempts + " tentative(s).", "Rejouer");
  }
  updateHUD();
}

/* ---------------------------- Entrées ---------------------------- */
window.addEventListener("keydown", (e) => {
  if(["ArrowLeft","q","Q"].includes(e.key)){ input.left = true; e.preventDefault(); }
  if(["ArrowRight","d","D"].includes(e.key)){ input.right = true; e.preventDefault(); }
  if(["ArrowUp"," ","w","W","z","Z"].includes(e.key)){ input.jumpQueued = true; e.preventDefault(); }
  if(e.key === "r" || e.key === "R") buildLevel(level);
});
window.addEventListener("keyup", (e) => {
  if(["ArrowLeft","q","Q"].includes(e.key)) input.left = false;
  if(["ArrowRight","d","D"].includes(e.key)) input.right = false;
});
/* Boutons tactiles : on capture le pointeur au doigt levé/posé plutôt que de
   se fier à "pointerleave". Sans capture, un minuscule tremblement du doigt
   qui sort ne serait-ce qu'un pixel du bouton déclenche "pointerleave" et
   relâche la touche alors que le doigt est toujours posé — c'est la cause la
   plus fréquente d'un déplacement qui "se bloque" alors qu'on reste appuyé.
   Avec setPointerCapture, seul un vrai relâchement (pointerup/cancel) compte. */
function bindHold(el, onDown, onUp){
  el.style.touchAction = "none";
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if(el.setPointerCapture) el.setPointerCapture(e.pointerId);
    onDown();
  });
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
}
bindHold(document.getElementById("btnLeft"), () => input.left=true, () => input.left=false);
bindHold(document.getElementById("btnRight"), () => input.right=true, () => input.right=false);
bindHold(document.getElementById("btnJump"), () => input.jumpQueued=true, () => {});

/* ---------------------------- Import manuel de niveau (JSON) ---------------------------- */
/* Sert à vérifier qu'un niveau conçu dans l'éditeur se comporte à
   l'identique une fois chargé ici, dans le vrai jeu — même moteur, mêmes
   fichiers levels.js/engine.js/render.js. L'intégration Firebase (chargement
   automatique de tous les niveaux distants) viendra remplacer/compléter
   ceci plus tard ; pour l'instant l'import est manuel, en local. */
document.getElementById("btnImportLevel").addEventListener("click", () => {
  document.getElementById("fileImportLevel").click();
});
document.getElementById("fileImportLevel").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const parsed = JSON.parse(reader.result);
      /* Accepte un niveau seul (format exporté par l'éditeur), ou par
         confort un ancien export multi-niveaux ({levels:[...]} ou tableau)
         dont on ne reprend que le premier niveau. */
      let imported;
      if(Array.isArray(parsed)) imported = parsed[0];
      else if(parsed.levels) imported = parsed.levels[0];
      else imported = parsed;
      if(!imported || !Array.isArray(imported.objects)) throw new Error("format de niveau inattendu");
      if(!imported.playerStart) imported.playerStart = {x:40,y:372};
      if(!imported.exit) imported.exit = {x:720,y:360,w:40,h:60};
      if(!imported.difficulty) imported.difficulty = 1;
      if(!imported.name) imported.name = imported.id || "Niveau importé";
      if(!imported.id) imported.id = "imported"+Date.now();
      // Évite d'écraser la progression d'un niveau déjà présent (intégré ou déjà importé).
      const taken = allLevels().some(lv => lv.id === imported.id);
      if(taken) imported.id = imported.id + "-" + Date.now();
      IMPORTED_LEVELS.push(imported);
      ensureLevelProgress(imported.id);
      buildLevel(imported);
      closeDrawer();
    }catch(err){ alert("Fichier JSON invalide : " + err.message); }
  };
  reader.readAsText(file);
  e.target.value = "";
});

/* ---------------------------- Firebase (chargement des niveaux FINAL) ----------------------------
   Uniquement piloté par js/firebase-config.js — pas de réglage modifiable
   depuis l'interface : la seule façon de pointer vers une autre base est de
   modifier ce fichier directement avant de déployer. */
/* Charge tous les niveaux marqués "FINAL" sur Firebase et les ajoute à la
   liste jouable. Silencieux si aucune base n'est configurée, ou en cas
   d'échec réseau (le jeu reste jouable avec les niveaux intégrés). */
async function loadFirebaseFinalLevels(){
  const settings = getFirebaseSettings();
  if(!settings.databaseURL) return 0;
  try{
    const levels = await firebaseListLevels(settings);
    FIREBASE_LEVELS = [];
    for(const id of Object.keys(levels)){
      const lv = levels[id];
      if(lv && lv.status === "FINAL" && Array.isArray(lv.objects)){
        FIREBASE_LEVELS.push(lv);
        ensureLevelProgress(lv.id || id);
      }
    }
    renderDrawer();
    return FIREBASE_LEVELS.length;
  }catch(err){
    return -1;
  }
}
/* Au tout premier chargement de la page, si une base est déjà configurée
   (fichier firebase-config.js ou réglage précédemment enregistré), on
   récupère les niveaux FINAL sans rien demander à l'utilisateur. */
loadFirebaseFinalLevels();

/* ---------------------------- PWA ---------------------------- */
if("serviceWorker" in navigator){
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
  /* Dès qu'une nouvelle version du service worker prend le relais (après
     un déploiement), on recharge une fois automatiquement — sinon la page
     ouverte continue d'utiliser les anciens fichiers déjà en mémoire tant
     qu'on ne rafraîchit pas manuellement. */
  let swRefreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if(swRefreshing) return;
    swRefreshing = true;
    window.location.reload();
  });
}
let deferredPrompt = null;
const installBtn = document.getElementById("installBtn");
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); deferredPrompt = e; installBtn.classList.add("show");
});
installBtn.addEventListener("click", async () => {
  if(!deferredPrompt) return;
  deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null;
  installBtn.classList.remove("show");
});

/* ---------------------------- Démarrage ---------------------------- */
/* Verrouillage de l'orientation en paysage (fonctionne surtout en PWA
   installée / plein écran). Dans un simple onglet de navigateur, le repli
   CSS (#rotateOverlay) prend le relais dans tous les cas. */
if(matchMedia("(max-width: 900px)").matches && screen.orientation && screen.orientation.lock){
  screen.orientation.lock("landscape").catch(()=>{});
}

buildLevel(LEVELS_SOURCE[0]);
requestAnimationFrame(frame);
