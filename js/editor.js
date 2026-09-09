"use strict";
/* =========================================================================
   ÉDITEUR DE NIVEAUX — Chute Libre
   Modèle de données identique à celui consommé par le jeu (LEVELS_SOURCE) :
   un niveau = { id, name, difficulty, playerStart, exit, objects:[...] }.
   Chaque objet peut porter un `trap` { trigger, action, then[] }. L'éditeur
   permet de poser, déplacer, redimensionner, paramétrer et relier ces
   objets, puis d'exporter le tout en JSON directement rejouable.
   Le mode "Tester" réutilise le même moteur physique/triggers que le jeu
   (copié depuis js/engine.js) pour un aller-retour édition/test immédiat.
   ========================================================================= */

const W = 800, H = 450;
const DEFAULT_GRAVITY = 2200;
const MOVE_SPEED = 240, JUMP_VELOCITY = -620, MAX_FALL = 900, STEP_UP = 14;
let currentGravity = DEFAULT_GRAVITY;
const GRID = 20;

/* ---------------------------- Bibliothèque d'objets (palette) ----------------------------
   Volontairement réduite à un petit socle générique et composable : tout le
   reste (plateforme qui tombe, porte, porte verrouillée, plafond surgissant,
   décor) se reconstruit à partir de "Sol / plateforme" + trigger/action/lien
   — c'est plus flexible qu'un catalogue figé de blocs spécialisés, et c'est
   la logique "kit" du jeu. Les anciens exports JSON contenant ces kinds
   (falling, door, gate, blocker, decoy) restent affichés correctement si
   réimportés : seul le rendu générique est conservé, seule la palette est
   réduite. */
const KIND_LIB = [
  { kind:"static", label:"Sol / plateforme / mur", color:"#a1382a", w:120, h:40,
    defaults:{ solid:true, trap:{ trigger:{type:"ON_ENTER"}, action:{type:"NONE"} } } },
  { kind:"hidden_spike", label:"Pic caché", color:"#e0455c", w:20, h:20,
    defaults:{ solid:false, hazard:true, visible:false, description:"Un pic caché se révèle quand on approche.",
      trap:{ trigger:{type:"ON_ENTER"}, action:{type:"REVEAL", delay:150} } } },
  { kind:"button", label:"Bouton", color:"#8a6a3a", w:60, h:20,
    defaults:{ solid:false, description:"Un bouton qui déclenche quelque chose ailleurs.",
      trap:{ trigger:{type:"ON_ENTER"}, action:{type:"ACTIVATE"} } } },
  { kind:"sensor", label:"Déclencheur (zone invisible)", color:"#3d5af1", w:40, h:40,
    defaults:{ solid:false, visible:false,
      trap:{ trigger:{type:"ON_ENTER"}, action:{type:"NONE"} } } },
];
function kindMeta(kind){ return KIND_LIB.find(k=>k.kind===kind) || KIND_LIB[0]; }

const TRIGGER_TYPES = [
  { type:"NONE", label:"Aucun" },
  { type:"ON_LAND", label:"À l'atterrissage (ON_LAND)" },
  { type:"ON_ENTER", label:"En entrant dans la zone (ON_ENTER)" },
  { type:"ON_JUMP", label:"Au moment du saut (ON_JUMP)" },
  { type:"ON_TIMER", label:"Après un délai depuis le début (ON_TIMER)" },
  { type:"ON_ATTEMPT", label:"À partir de la N-ième tentative (ON_ATTEMPT)" },
];
const ACTION_TYPES = [
  { type:"NONE", label:"Aucune" },
  { type:"FALL", label:"Trembler puis tomber (FALL)" },
  { type:"DISAPPEAR", label:"Disparaître (DISAPPEAR)" },
  { type:"REVEAL", label:"Se révéler (REVEAL)" },
  { type:"OPEN", label:"S'ouvrir / devenir traversable (OPEN)" },
  { type:"ACTIVATE", label:"S'activer (cosmétique) (ACTIVATE)" },
  { type:"APPEAR_TEMP", label:"Surgir puis se rétracter (APPEAR_TEMP)" },
  { type:"DISABLE", label:"Désactiver silencieusement la cible (DISABLE)" },
  { type:"MOVE", label:"Translation à vitesse constante (MOVE)" },
  { type:"ROTATE", label:"Rotation continue (ROTATE)" },
];
/* Actions disponibles sur la cible spéciale SCENE (paramètres globaux du
   niveau) et sur la cible spéciale PLAYER (le personnage lui-même). */
const SCENE_ACTION_TYPES = [
  { type:"NONE", label:"Aucune" },
  { type:"SET_GRAVITY", label:"Changer la gravité (SET_GRAVITY)" },
];
const PLAYER_ACTION_TYPES = [
  { type:"NONE", label:"Aucune" },
  { type:"MOVE", label:"Impulsion de déplacement (MOVE)" },
  { type:"CHANGE_WIDTH", label:"Changer la largeur (CHANGE_WIDTH)" },
  { type:"CHANGE_HEIGHT", label:"Changer la hauteur (CHANGE_HEIGHT)" },
];
function actionTypesForTarget(target){
  if(target==="SCENE") return SCENE_ACTION_TYPES;
  if(target==="PLAYER") return PLAYER_ACTION_TYPES;
  return ACTION_TYPES;
}

/* ---------------------------- Modèle de document ---------------------------- */
/* Identifiant aléatoire tiré à la création d'un niveau — sert de clé sur
   Firebase et d'ordre de classement dans le serpentin du jeu (les niveaux
   sont triés par cet identifiant, pas par leur nom). Purement numérique :
   toujours une clé valide pour la Realtime Database. */
function randomLevelId(){
  return String(Math.floor(100000000 + Math.random()*900000000));
}
function makeEmptyLevel(id, name){
  return {
    id: id || randomLevelId(), name, difficulty:1, gravity:DEFAULT_GRAVITY, playerStart:{x:40,y:372}, exit:{x:720,y:360,w:40,h:60},
    /* Fermé en haut/gauche/droite par défaut : la seule façon de "sortir"
       est de tomber (mort) ou d'atteindre la sortie — jamais un bord d'écran.
       Ce sont des objets comme les autres : déplaçables/supprimables si
       le niveau en a besoin autrement. */
    objects:[
      { id:"_boundTop", kind:"gate", x:0,y:0,w:800,h:20, solid:true },
      { id:"_boundLeft", kind:"gate", x:0,y:0,w:20,h:450, solid:true },
      { id:"_boundRight", kind:"gate", x:780,y:0,w:20,h:450, solid:true },
    ],
  };
}
let level = makeEmptyLevel(null, "Niveau 1");
function curLevel(){ return level; }

let selectedId = null;
let mode = "select"; // "select" | "place" | "link"
let placeKind = null;
let linkSourceId = null;

function selectedObj(){
  if(selectedId === "__playerStart__" || selectedId === "__exit__") return null;
  return curLevel().objects.find(o=>o.id===selectedId) || null;
}
function uniqueId(base){
  const lvl = curLevel();
  let n = 1, id = base;
  const exists = (x)=> lvl.objects.some(o=>o.id===x) || x==="playerStart" || x==="exit";
  while(exists(id)){ n++; id = base+n; }
  return id;
}
/* Les murs de bordure (_boundTop/_boundLeft/_boundRight) sont posés par
   défaut sur chaque niveau et ne doivent jamais pouvoir être supprimés —
   comme la sortie et le point de départ, ce sont des repères structurels. */
function isLocked(id){ return typeof id === "string" && id.indexOf("_bound") === 0; }
function snap(v){ return gridOn ? Math.round(v/GRID)*GRID : Math.round(v); }

/* ---------------------------- Vue (zoom / pan) ---------------------------- */
/* Le canvas ne dessine plus dans un cadre 800x450 figé : il occupe tout
   #canvasWrap, et une transformation (zoom + décalage) place le "monde"
   (toujours 800x450 en coordonnées de niveau) dedans. Toutes les coordonnées
   souris passent par canvasPoint(), qui applique déjà l'inverse de cette
   transformation — le reste du code (sélection, drag, placement) continue
   de raisonner en coordonnées du monde sans rien savoir du zoom. */
let view = { zoom: 1, offsetX: 0, offsetY: 0 };
let panModeOn = false;
let panDrag = null;

function resizeCanvasToContainer(){
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width));
  canvas.height = Math.max(1, Math.round(rect.height));
}
function fitView(){
  const pad = 24;
  const zx = (canvas.width - pad*2) / W;
  const zy = (canvas.height - pad*2) / H;
  view.zoom = Math.max(0.1, Math.min(zx, zy, 3));
  view.offsetX = (canvas.width - W*view.zoom) / 2;
  view.offsetY = (canvas.height - H*view.zoom) / 2;
  updateZoomLabel();
}
function setZoom(newZoom, pivotScreenX, pivotScreenY){
  newZoom = Math.max(0.15, Math.min(4, newZoom));
  const worldX = (pivotScreenX - view.offsetX) / view.zoom;
  const worldY = (pivotScreenY - view.offsetY) / view.zoom;
  view.zoom = newZoom;
  view.offsetX = pivotScreenX - worldX * view.zoom;
  view.offsetY = pivotScreenY - worldY * view.zoom;
  updateZoomLabel();
}
function updateZoomLabel(){
  const lbl = document.getElementById("zoomLabel");
  if(lbl) lbl.textContent = Math.round(view.zoom*100) + "%";
}

/* ---------------------------- Rendu (réutilise le style brique du jeu) ---------------------------- */
const canvas = document.getElementById("editorCanvas");
const ctx = canvas.getContext("2d");
let gridOn = true;

function drawBrick(x,y,w,h){
  const brickW=22, brickH=11, gap=2;
  ctx.save(); ctx.beginPath(); ctx.rect(x,y,w,h); ctx.clip();
  ctx.fillStyle="#d8c6ad"; ctx.fillRect(x,y,w,h);
  ctx.fillStyle="#a1382a";
  let row = Math.floor(y/brickH);
  for(let ry=Math.floor(y/brickH)*brickH; ry<y+h; ry+=brickH){
    const rh=Math.min(brickH-gap, y+h-Math.max(ry,y)); const rowTop=Math.max(ry,y);
    if(rh<=0){ row++; continue; }
    const offset=(row%2===0)?0:-brickW/2;
    for(let bx=Math.floor((x-offset)/brickW)*brickW+offset; bx<x+w; bx+=brickW){
      const left=Math.max(bx,x), right=Math.min(bx+brickW-gap,x+w);
      if(right>left) ctx.fillRect(left, rowTop, right-left, rh);
    }
    row++;
  }
  ctx.restore();
}
function drawStoneBrick(x,y,w,h){
  const brickW=20, brickH=12, gap=2;
  ctx.save(); ctx.beginPath(); ctx.rect(x,y,w,h); ctx.clip();
  ctx.fillStyle="#c7cbd6"; ctx.fillRect(x,y,w,h);
  ctx.fillStyle="#575d6e";
  let row = Math.floor(y/brickH);
  for(let ry=Math.floor(y/brickH)*brickH; ry<y+h; ry+=brickH){
    const rh=Math.min(brickH-gap, y+h-Math.max(ry,y)); const rowTop=Math.max(ry,y);
    if(rh<=0){ row++; continue; }
    const offset=(row%2===0)?0:-brickW/2;
    for(let bx=Math.floor((x-offset)/brickW)*brickW+offset; bx<x+w; bx+=brickW){
      const left=Math.max(bx,x), right=Math.min(bx+brickW-gap,x+w);
      if(right>left) ctx.fillRect(left, rowTop, right-left, rh);
    }
    row++;
  }
  ctx.restore();
}

function drawObjectEditor(o, isSelected){
  const meta = kindMeta(o.kind);
  const invisibleInGame = (o.visible === false);
  ctx.save();
  if(invisibleInGame){ ctx.globalAlpha = 0.45; }
  if(o.angle){
    const cx = o.x+o.w/2, cy = o.y+o.h/2;
    ctx.translate(cx,cy); ctx.rotate(o.angle*Math.PI/180); ctx.translate(-cx,-cy);
  }

  switch(o.kind){
    case "static": case "decoy": drawBrick(o.x,o.y,o.w,o.h); break;
    case "falling":
      drawBrick(o.x,o.y,o.w,o.h);
      ctx.strokeStyle="rgba(40,20,10,.5)"; ctx.lineWidth=1.5;
      ctx.beginPath(); ctx.moveTo(o.x+o.w*0.32,o.y+2); ctx.lineTo(o.x+o.w*0.45,o.y+o.h*0.6); ctx.lineTo(o.x+o.w*0.38,o.y+o.h-2); ctx.stroke();
      break;
    case "gate": drawStoneBrick(o.x,o.y,o.w,o.h); break;
    case "blocker":
      drawBrick(o.x,o.y,o.w,o.h);
      ctx.strokeStyle="rgba(224,69,92,.6)"; ctx.lineWidth=2; ctx.strokeRect(o.x+1,o.y+1,o.w-2,o.h-2);
      break;
    case "hidden_spike":
      ctx.fillStyle="#e0455c";
      for(let i=0;i<3;i++){ const sx=o.x+i*(o.w/3);
        ctx.beginPath(); ctx.moveTo(sx,o.y+o.h); ctx.lineTo(sx+o.w/6,o.y); ctx.lineTo(sx+o.w/3,o.y+o.h); ctx.closePath(); ctx.fill(); }
      break;
    case "door":
      drawDoorShape(o.x,o.y,o.w,o.h, "#3d5af1", "#eef0ff", "#1f2d8a");
      break;
    case "button":
      drawStoneBrick(o.x,o.y,o.w,o.h);
      { const cx=o.x+o.w/2, cy=o.y+o.h/2, r=Math.min(o.w,o.h)*0.28;
        ctx.fillStyle = o.state==="activated" ? "#4f8f6a" : "#8a6a3a";
        ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill(); }
      break;
    case "sensor":
      ctx.fillStyle="rgba(61,90,241,.18)"; ctx.fillRect(o.x,o.y,o.w,o.h);
      ctx.strokeStyle="#3d5af1"; ctx.setLineDash([4,3]); ctx.lineWidth=1.5; ctx.strokeRect(o.x,o.y,o.w,o.h); ctx.setLineDash([]);
      break;
  }

  if(invisibleInGame && o.kind!=="sensor"){
    ctx.globalAlpha = 1;
    ctx.strokeStyle="rgba(61,90,241,.7)"; ctx.setLineDash([4,3]); ctx.lineWidth=1.5;
    ctx.strokeRect(o.x+0.5,o.y+0.5,o.w-1,o.h-1); ctx.setLineDash([]);
  }
  ctx.restore();

  // étiquette id
  ctx.fillStyle="rgba(20,22,36,.65)"; ctx.font=(10/view.zoom)+"px monospace"; ctx.textAlign="left";
  ctx.fillText(o.id, o.x+3, o.y-3 < 8 ? o.y+12 : o.y-3);

  if(isSelected){
    ctx.strokeStyle="#3d5af1"; ctx.lineWidth=2/view.zoom; ctx.strokeRect(o.x-2,o.y-2,o.w+4,o.h+4);
    // poignée de redimensionnement (coin bas-droit) — taille constante à l'écran
    const hs = 12/view.zoom;
    ctx.fillStyle="#3d5af1"; ctx.fillRect(o.x+o.w-hs/2,o.y+o.h-hs/2,hs,hs);
  }
}

/* Porte : un cadre arrondi + un panneau intérieur + une barre + une
   poignée, plutôt qu'un simple rectangle bleu. Partagée par le mode
   édition et le mode test, et par la sortie et les objets "door". */
function drawDoorShape(x,y,w,h, mainColor, panelColor, knobColor){
  ctx.save();
  const r = Math.min(w,h)*0.18;
  ctx.fillStyle = mainColor;
  ctx.beginPath();
  ctx.moveTo(x, y+h);
  ctx.lineTo(x, y+r);
  ctx.quadraticCurveTo(x, y, x+r, y);
  ctx.lineTo(x+w-r, y);
  ctx.quadraticCurveTo(x+w, y, x+w, y+r);
  ctx.lineTo(x+w, y+h);
  ctx.closePath();
  ctx.fill();

  const pad = w*0.14;
  const px=x+pad, py=y+pad*1.3, pw=w-pad*2, ph=h-pad*2.1;
  const pr = pw*0.22;
  ctx.fillStyle = panelColor;
  ctx.beginPath();
  ctx.moveTo(px, py+ph);
  ctx.lineTo(px, py+pr);
  ctx.quadraticCurveTo(px, py, px+pr, py);
  ctx.lineTo(px+pw-pr, py);
  ctx.quadraticCurveTo(px+pw, py, px+pw, py+pr);
  ctx.lineTo(px+pw, py+ph);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = mainColor; ctx.lineWidth = Math.max(1.5, w*0.05);
  ctx.beginPath(); ctx.moveTo(px, py+ph*0.55); ctx.lineTo(px+pw, py+ph*0.55); ctx.stroke();

  ctx.fillStyle = knobColor;
  ctx.beginPath(); ctx.arc(x+w-pad*1.3, y+h*0.55, Math.max(2, w*0.07), 0, Math.PI*2); ctx.fill();
  ctx.restore();
}

function drawGrid(){
  if(!gridOn) return;
  ctx.strokeStyle="rgba(30,34,60,.06)"; ctx.lineWidth=1/view.zoom;
  for(let x=0;x<=W;x+=GRID){ ctx.beginPath(); ctx.moveTo(x+0.5,0); ctx.lineTo(x+0.5,H); ctx.stroke(); }
  for(let y=0;y<=H;y+=GRID){ ctx.beginPath(); ctx.moveTo(0,y+0.5); ctx.lineTo(W,y+0.5); ctx.stroke(); }
}

function drawCascadeArrows(){
  const lvl = curLevel();
  ctx.strokeStyle="rgba(224,69,92,.8)"; ctx.fillStyle="rgba(224,69,92,.8)"; ctx.lineWidth=1.5;
  for(const o of lvl.objects){
    if(!o.trap || !o.trap.then) continue;
    for(const link of o.trap.then){
      const target = lvl.objects.find(t=>t.id===link.target);
      if(!target) continue;
      const x1=o.x+o.w/2, y1=o.y+o.h/2, x2=target.x+target.w/2, y2=target.y+target.h/2;
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
      const ang = Math.atan2(y2-y1,x2-x1);
      ctx.save(); ctx.translate(x2,y2); ctx.rotate(ang);
      ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(-9,-4); ctx.lineTo(-9,4); ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.font="10px sans-serif"; ctx.textAlign="center";
      ctx.fillText((link.delay||0)+"ms", (x1+x2)/2, (y1+y2)/2-4);
    }
  }
}

function drawPlayerStartAndExit(){
  const lvl = curLevel();
  // exit
  const e = lvl.exit;
  ctx.save();
  ctx.fillStyle="rgba(47,179,128,.25)"; ctx.fillRect(e.x,e.y,e.w,e.h);
  ctx.strokeStyle="#2fb380"; ctx.setLineDash(selectedId==="__exit__"?[]:[5,3]); ctx.lineWidth=selectedId==="__exit__"?2.5:1.5;
  ctx.strokeRect(e.x+0.5,e.y+0.5,e.w-1,e.h-1); ctx.setLineDash([]);
  ctx.fillStyle="#1d7a54"; ctx.font="10px monospace"; ctx.fillText("exit", e.x+3, e.y-3<8?e.y+12:e.y-3);
  if(selectedId==="__exit__"){ ctx.fillStyle="#2fb380"; ctx.fillRect(e.x+e.w-6,e.y+e.h-6,12,12); }
  ctx.restore();
  // player start
  const p = lvl.playerStart;
  ctx.save();
  ctx.fillStyle = selectedId==="__playerStart__" ? "#2a3fc0" : "#3d5af1";
  ctx.beginPath(); ctx.arc(p.x+13,p.y+19,14,0,Math.PI*2); ctx.fill();
  ctx.fillStyle="#fff"; ctx.font="16px sans-serif"; ctx.textAlign="center"; ctx.fillText("▶", p.x+13, p.y+24);
  ctx.restore();
}

function render(){
  ctx.save();
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle = "#e7e9f3"; ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.setTransform(view.zoom,0,0,view.zoom, view.offsetX, view.offsetY);

  const grad = ctx.createLinearGradient(0,0,0,H);
  grad.addColorStop(0,"#eef1fb"); grad.addColorStop(1,"#e2e6f6");
  ctx.fillStyle=grad; ctx.fillRect(0,0,W,H);
  drawGrid();
  const lvl = curLevel();
  for(const o of lvl.objects) drawObjectEditor(o, o.id===selectedId);
  drawCascadeArrows();
  drawPlayerStartAndExit();
  if(mode==="link"){
    ctx.fillStyle="rgba(20,22,36,.7)"; ctx.font="13px sans-serif"; ctx.textAlign="center";
    ctx.fillText(linkSourceId ? "Clique la cible du lien…" : "Clique l'objet source du lien…", W/2, 20);
  }
  ctx.restore();
}

/* ---------------------------- Interaction souris/tactile ---------------------------- */
let drag = null; // {type:'move'|'resize', id, offsetX, offsetY, startW, startH}

function canvasPoint(evt){
  const rect = canvas.getBoundingClientRect();
  const cx = (evt.touches ? evt.touches[0].clientX : evt.clientX) - rect.left;
  const cy = (evt.touches ? evt.touches[0].clientY : evt.clientY) - rect.top;
  // écran -> pixels canvas (le canvas peut être affiché à une taille CSS
  // différente de sa résolution interne) -> monde (en inversant zoom/pan).
  const px = cx * (canvas.width/rect.width), py = cy * (canvas.height/rect.height);
  return { x: (px-view.offsetX)/view.zoom, y: (py-view.offsetY)/view.zoom, screenX:px, screenY:py };
}
function hitTest(pt){
  const lvl = curLevel();
  const e = lvl.exit;
  if(pt.x>=e.x && pt.x<=e.x+e.w && pt.y>=e.y && pt.y<=e.y+e.h) return "__exit__";
  const p = lvl.playerStart;
  if(Math.hypot(pt.x-(p.x+13), pt.y-(p.y+19)) <= 15) return "__playerStart__";
  for(let i=lvl.objects.length-1;i>=0;i--){
    const o = lvl.objects[i];
    if(pt.x>=o.x && pt.x<=o.x+o.w && pt.y>=o.y && pt.y<=o.y+o.h) return o.id;
  }
  return null;
}
function onResizeHandle(pt, o){
  const m = 10/view.zoom, m2 = 4/view.zoom;
  return pt.x >= o.x+o.w-m && pt.x <= o.x+o.w+m2 && pt.y >= o.y+o.h-m && pt.y <= o.y+o.h+m2;
}

canvas.addEventListener("wheel", (evt)=>{
  if(playRunning) return;
  evt.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const screenX = (evt.clientX-rect.left) * (canvas.width/rect.width);
  const screenY = (evt.clientY-rect.top) * (canvas.height/rect.height);
  const factor = evt.deltaY < 0 ? 1.12 : 1/1.12;
  setZoom(view.zoom*factor, screenX, screenY);
  render();
}, { passive:false });

canvas.addEventListener("pointerdown", (evt)=>{
  if(playRunning) return;

  if(panModeOn || evt.button===1){
    evt.preventDefault();
    panDrag = { startX:evt.clientX, startY:evt.clientY, startOffsetX:view.offsetX, startOffsetY:view.offsetY };
    canvas.setPointerCapture(evt.pointerId);
    return;
  }

  const pt = canvasPoint(evt);

  if(mode==="place" && placeKind){
    const meta = kindMeta(placeKind);
    const id = uniqueId(placeKind);
    const obj = Object.assign({ id, kind:placeKind, x:snap(pt.x-meta.w/2), y:snap(pt.y-meta.h/2), w:meta.w, h:meta.h, visible:true },
      JSON.parse(JSON.stringify(meta.defaults||{})));
    curLevel().objects.push(obj);
    selectedId = id; mode="select"; placeKind=null;
    refreshPaletteActive(); renderInspector(); render();
    setInspectorOpen(true);
    return;
  }

  const hit = hitTest(pt);

  if(mode==="link"){
    if(hit && hit!=="__exit__" && hit!=="__playerStart__"){
      if(!linkSourceId){ linkSourceId = hit; render(); }
      else if(linkSourceId!==hit){
        const src = curLevel().objects.find(o=>o.id===linkSourceId);
        if(!src.trap) src.trap = {};
        if(!src.trap.trigger) src.trap.trigger = {type:"ON_ENTER"};
        if(!src.trap.action) src.trap.action = {type:"NONE"};
        if(!src.trap.then) src.trap.then = [];
        src.trap.then.push({ target: hit, delay: 200, action:{type:"NONE"} });
        selectedId = linkSourceId; linkSourceId=null; mode="select";
        renderInspector(); render();
      }
    }
    return;
  }

  selectedId = hit;
  renderInspector();
  if(hit && hit!=="__playerStart__" && hit!=="__exit__"){
    const o = curLevel().objects.find(x=>x.id===hit);
    if(onResizeHandle(pt,o)){
      drag = { type:"resize", id:hit, startW:o.w, startH:o.h, startX:pt.x, startY:pt.y };
    } else {
      drag = { type:"move", id:hit, offsetX:pt.x-o.x, offsetY:pt.y-o.y };
    }
  } else if(hit==="__exit__"){
    const e = curLevel().exit;
    if(pt.x>=e.x+e.w-10 && pt.y>=e.y+e.h-10) drag={ type:"resizeExit", startW:e.w, startH:e.h, startX:pt.x, startY:pt.y };
    else drag = { type:"moveExit", offsetX:pt.x-e.x, offsetY:pt.y-e.y };
  } else if(hit==="__playerStart__"){
    const p = curLevel().playerStart;
    drag = { type:"moveStart", offsetX:pt.x-p.x, offsetY:pt.y-p.y };
  }
  render();
  canvas.setPointerCapture(evt.pointerId);
});
canvas.addEventListener("pointermove", (evt)=>{
  if(playRunning) return;
  if(panDrag){
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width/rect.width, scaleY = canvas.height/rect.height;
    view.offsetX = panDrag.startOffsetX + (evt.clientX-panDrag.startX)*scaleX;
    view.offsetY = panDrag.startOffsetY + (evt.clientY-panDrag.startY)*scaleY;
    render();
    return;
  }
  if(!drag) return;
  const pt = canvasPoint(evt);
  if(drag.type==="move"){
    const o = curLevel().objects.find(x=>x.id===drag.id);
    o.x = snap(Math.max(0,Math.min(W-o.w, pt.x-drag.offsetX)));
    o.y = snap(Math.max(0,Math.min(H-o.h, pt.y-drag.offsetY)));
    renderInspector(); render();
  } else if(drag.type==="resize"){
    const o = curLevel().objects.find(x=>x.id===drag.id);
    o.w = Math.max(GRID, snap(drag.startW + (pt.x-drag.startX)));
    o.h = Math.max(GRID, snap(drag.startH + (pt.y-drag.startY)));
    renderInspector(); render();
  } else if(drag.type==="moveExit"){
    const e = curLevel().exit;
    e.x = snap(Math.max(0,Math.min(W-e.w, pt.x-drag.offsetX)));
    e.y = snap(Math.max(0,Math.min(H-e.h, pt.y-drag.offsetY)));
    renderInspector(); render();
  } else if(drag.type==="resizeExit"){
    const e = curLevel().exit;
    e.w = Math.max(GRID, snap(drag.startW + (pt.x-drag.startX)));
    e.h = Math.max(GRID, snap(drag.startH + (pt.y-drag.startY)));
    renderInspector(); render();
  } else if(drag.type==="moveStart"){
    const p = curLevel().playerStart;
    p.x = snap(Math.max(0,Math.min(W-26, pt.x-drag.offsetX)));
    p.y = snap(Math.max(0,Math.min(H-38, pt.y-drag.offsetY)));
    renderInspector(); render();
  }
});
window.addEventListener("pointerup", ()=>{ drag=null; panDrag=null; });

/* ---------------------------- Palette ---------------------------- */
const paletteListEl = document.getElementById("paletteList");
function buildPalette(){
  paletteListEl.innerHTML = "";
  for(const k of KIND_LIB){
    const btn = document.createElement("button");
    btn.className = "paletteBtn"; btn.dataset.kind = k.kind;
    btn.innerHTML = '<span class="swatch" style="background:'+k.color+'"></span><span>'+k.label+'<small>'+k.kind+'</small></span>';
    btn.addEventListener("click", ()=>{
      if(mode==="place" && placeKind===k.kind){ mode="select"; placeKind=null; }
      else { mode="place"; placeKind=k.kind; }
      refreshPaletteActive(); render();
      closeMobileDrawers();
    });
    paletteListEl.appendChild(btn);
  }
}
function refreshPaletteActive(){
  paletteListEl.querySelectorAll(".paletteBtn").forEach(b=>{
    b.classList.toggle("active", mode==="place" && b.dataset.kind===placeKind);
  });
}

/* ---------------------------- Inspecteur ---------------------------- */
const inspectorBody = document.getElementById("inspectorBody");
const levelMetaEl = document.getElementById("levelMeta");
const btnDuplicate = document.getElementById("btnDuplicate");
const btnDelete = document.getElementById("btnDelete");

/* Le panneau de propriétés est indépendant de la sélection : cliquer un
   objet sur la scène le sélectionne (contour bleu, boutons dupliquer/
   supprimer actifs) et rafraîchit le CONTENU du panneau, mais ne l'ouvre
   pas. Seule l'icône ⚙️ (ou reposer un nouvel objet) l'ouvre ; le bouton ✕
   et un clic en dehors le referment — sans perdre la sélection. */
let inspectorOpen = false;
function setInspectorOpen(v){
  inspectorOpen = v;
  document.getElementById("inspector").classList.toggle("open", inspectorOpen);
}
document.getElementById("btnCloseInspector").addEventListener("click", ()=>{ setInspectorOpen(false); });
document.getElementById("btnToggleInspector").addEventListener("click", ()=>{
  document.getElementById("palette").classList.remove("open");
  setInspectorOpen(!inspectorOpen);
});
/* Clic en dehors du panneau (et en dehors du canvas, qui gère déjà sa propre
   sélection) : referme le panneau s'il était ouvert. */
document.addEventListener("pointerdown", (evt)=>{
  if(playRunning) return;
  if(!inspectorOpen) return;
  const insp = document.getElementById("inspector");
  if(insp.contains(evt.target)) return;
  if(canvas.contains(evt.target)) return;
  setInspectorOpen(false);
});

function el(tag, attrs, ...children){
  const e = document.createElement(tag);
  for(const k in (attrs||{})){
    if(k==="text") e.textContent = attrs[k];
    else if(k.startsWith("on")) e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  for(const c of children) if(c) e.appendChild(c);
  return e;
}

function renderLevelMeta(){
  const lvl = curLevel();
  levelMetaEl.innerHTML = "";
  const idField = el("div",{class:"field"}, el("label",{text:"Identifiant du niveau"}),
    el("input",{type:"text", value:lvl.id, oninput:(e)=>{ lvl.id=e.target.value; }}));
  const nameField = el("div",{class:"field"}, el("label",{text:"Nom"}),
    el("input",{type:"text", value:lvl.name, oninput:(e)=>{ lvl.name=e.target.value; }}));
  const diffField = el("div",{class:"field"}, el("label",{text:"Difficulté (1-5)"}),
    el("input",{type:"number", min:"1", max:"5", value:lvl.difficulty, oninput:(e)=>{ lvl.difficulty=Math.max(1,Math.min(5,parseInt(e.target.value)||1)); }}));
  const gravField = numField("Gravité (px/s², défaut "+DEFAULT_GRAVITY+")", lvl.gravity!=null?lvl.gravity:DEFAULT_GRAVITY, v=>{ lvl.gravity=v; });
  levelMetaEl.appendChild(idField); levelMetaEl.appendChild(nameField); levelMetaEl.appendChild(diffField); levelMetaEl.appendChild(gravField);
}

function numField(label, value, onchange){
  const input = el("input",{type:"number", value:value, oninput:(e)=>onchange(parseFloat(e.target.value)||0)});
  return el("div",{class:"field"}, el("label",{text:label}), input);
}
function textField(label, value, onchange){
  const input = el("input",{type:"text", value:value||"", oninput:(e)=>onchange(e.target.value)});
  return el("div",{class:"field"}, el("label",{text:label}), input);
}
function textareaField(label, value, onchange){
  const input = el("textarea",{oninput:(e)=>onchange(e.target.value)});
  input.value = value||"";
  return el("div",{class:"field"}, el("label",{text:label}), input);
}
function selectField(label, options, value, onchange){
  const select = el("select",{onchange:(e)=>onchange(e.target.value)});
  for(const opt of options){
    const o = el("option",{value:opt.type, text:opt.label});
    if(opt.type===value) o.selected = true;
    select.appendChild(o);
  }
  return el("div",{class:"field"}, el("label",{text:label}), select);
}
function checkField(label, checked, onchange){
  const input = el("input",{type:"checkbox", onchange:(e)=>onchange(e.target.checked)});
  input.checked = !!checked;
  const wrap = el("label",{class:"checkline"}, input, document.createTextNode(" "+label));
  return wrap;
}

function objectIdsExcept(id){
  return curLevel().objects.filter(o=>o.id!==id).map(o=>o.id);
}
/* Cibles spéciales de cascade, en plus des objets du niveau : SCENE (pour
   changer un paramètre global comme la gravité) et PLAYER (pour agir
   directement sur le personnage : taille, impulsion de déplacement). */
const SPECIAL_TARGETS = ["SCENE", "PLAYER"];
function allCascadeTargets(id){
  return SPECIAL_TARGETS.concat(objectIdsExcept(id));
}

function renderActionParams(container, action, onchange){
  container.innerHTML = "";
  if(action.type==="FALL"){
    container.appendChild(numField("Tremblement avant chute (ms)", action.shakeMs!=null?action.shakeMs:400, v=>{ action.shakeMs=v; onchange(); }));
    container.appendChild(numField("Vitesse de chute (px/s)", action.fallSpeed!=null?action.fallSpeed:260, v=>{ action.fallSpeed=v; onchange(); }));
  } else if(action.type==="REVEAL"){
    container.appendChild(numField("Délai avant révélation (ms)", action.delay!=null?action.delay:150, v=>{ action.delay=v; onchange(); }));
  } else if(action.type==="APPEAR_TEMP"){
    container.appendChild(numField("Durée avant rétractation (ms)", action.ms!=null?action.ms:500, v=>{ action.ms=v; onchange(); }));
  } else if(action.type==="MOVE"){
    container.appendChild(selectField("Direction", [
      {type:"left",label:"Gauche"},{type:"right",label:"Droite"},{type:"up",label:"Haut"},{type:"down",label:"Bas"}
    ], action.direction||"right", v=>{ action.direction=v; onchange(); }));
    container.appendChild(numField("Vitesse maximale (px/s)", action.speed!=null?action.speed:100, v=>{ action.speed=v; onchange(); }));
    container.appendChild(numField("Accélération (px/s², 0 = instantané)", action.acceleration!=null?action.acceleration:0, v=>{ action.acceleration=v; onchange(); }));
    container.appendChild(numField("Durée du mouvement (ms, 0 = indéfini)", action.duration!=null?action.duration:1000, v=>{ action.duration=v; onchange(); }));
  } else if(action.type==="ROTATE"){
    container.appendChild(selectField("Sens", [{type:"cw",label:"Horaire"},{type:"ccw",label:"Antihoraire"}], action.direction||"cw", v=>{ action.direction=v; onchange(); }));
    container.appendChild(numField("Vitesse (degrés/s)", action.speed!=null?action.speed:90, v=>{ action.speed=v; onchange(); }));
    container.appendChild(numField("Durée (ms, 0 = indéfini)", action.duration!=null?action.duration:0, v=>{ action.duration=v; onchange(); }));
  } else if(action.type==="SET_GRAVITY"){
    container.appendChild(numField("Nouvelle gravité (px/s²)", action.value!=null?action.value:DEFAULT_GRAVITY, v=>{ action.value=v; onchange(); }));
  } else if(action.type==="CHANGE_WIDTH"){
    container.appendChild(numField("Nouvelle largeur du joueur (px)", action.value!=null?action.value:26, v=>{ action.value=v; onchange(); }));
  } else if(action.type==="CHANGE_HEIGHT"){
    container.appendChild(numField("Nouvelle hauteur du joueur (px)", action.value!=null?action.value:38, v=>{ action.value=v; onchange(); }));
  }
}

function renderInspector(){
  inspectorBody.innerHTML = "";
  const lvl = curLevel();

  if(selectedId==="__exit__"){
    btnDuplicate.disabled = true; btnDelete.disabled = true;
    const e = lvl.exit;
    inspectorBody.appendChild(el("p",{}, document.createTextNode("Sortie du niveau")));
    const row = el("div",{class:"row2"});
    row.appendChild(numField("x", e.x, v=>{ e.x=v; render(); }));
    row.appendChild(numField("y", e.y, v=>{ e.y=v; render(); }));
    inspectorBody.appendChild(row);
    const row2 = el("div",{class:"row2"});
    row2.appendChild(numField("largeur", e.w, v=>{ e.w=v; render(); }));
    row2.appendChild(numField("hauteur", e.h, v=>{ e.h=v; render(); }));
    inspectorBody.appendChild(row2);
    return;
  }
  if(selectedId==="__playerStart__"){
    btnDuplicate.disabled = true; btnDelete.disabled = true;
    const p = lvl.playerStart;
    inspectorBody.appendChild(el("p",{}, document.createTextNode("Point de départ du joueur")));
    const row = el("div",{class:"row2"});
    row.appendChild(numField("x", p.x, v=>{ p.x=v; render(); }));
    row.appendChild(numField("y", p.y, v=>{ p.y=v; render(); }));
    inspectorBody.appendChild(row);
    return;
  }

  const o = selectedObj();
  if(!o){
    btnDuplicate.disabled = true; btnDelete.disabled = true;
    inspectorBody.innerHTML = '<p class="empty">Rien n\'est sélectionné. Clique un objet sur la scène, ou choisis un élément dans la bibliothèque pour en poser un nouveau.</p>';
    return;
  }
  btnDuplicate.disabled = false; btnDelete.disabled = isLocked(o.id);
  if(isLocked(o.id)){
    inspectorBody.appendChild(el("p",{class:"empty", text:"Mur de bordure par défaut — ne peut pas être supprimé."}));
  }

  inspectorBody.appendChild(el("div",{class:"field"},
    el("label",{text:"Identifiant"}),
    el("input",{type:"text", value:o.id, oninput:(e)=>{
      const v = e.target.value.trim();
      const dup = curLevel().objects.some(other=>other!==o && other.id===v);
      warnEl.textContent = (!v || dup) ? "Identifiant vide ou déjà utilisé." : "";
      if(v && !dup){
        const oldId = o.id;
        for(const other of curLevel().objects){
          if(other.trap && other.trap.then) for(const link of other.trap.then) if(link.target===oldId) link.target=v;
        }
        o.id = v; if(selectedId===oldId) selectedId=v;
      }
    }})
  ));
  const warnEl = el("div",{class:"idWarning"});
  inspectorBody.appendChild(warnEl);

  const posRow = el("div",{class:"row2"});
  posRow.appendChild(numField("x", o.x, v=>{ o.x=v; render(); }));
  posRow.appendChild(numField("y", o.y, v=>{ o.y=v; render(); }));
  inspectorBody.appendChild(posRow);
  const sizeRow = el("div",{class:"row2"});
  sizeRow.appendChild(numField("largeur", o.w, v=>{ o.w=Math.max(4,v); render(); }));
  sizeRow.appendChild(numField("hauteur", o.h, v=>{ o.h=Math.max(4,v); render(); }));
  inspectorBody.appendChild(sizeRow);

  inspectorBody.appendChild(selectField("Type d'objet (kind)", KIND_LIB.map(k=>({type:k.kind,label:k.label})), o.kind, v=>{ o.kind=v; render(); }));

  inspectorBody.appendChild(checkField("Solide (bloque le joueur)", o.solid, v=>{ o.solid=v; }));
  inspectorBody.appendChild(checkField("Dangereux au contact (hazard)", o.hazard, v=>{ o.hazard=v; }));
  inspectorBody.appendChild(checkField("Visible au démarrage", o.visible!==false, v=>{ o.visible=v; render(); }));
  inspectorBody.appendChild(checkField("Bloquant même invisible (sinon : invisible = non solide, tant qu'il n'est pas révélé)", o.solidWhenHidden, v=>{ o.solidWhenHidden=v; }));

  if(o.kind==="hidden_spike"){
    inspectorBody.appendChild(selectField("Direction du pic", [
      {type:"0", label:"Vers le haut"},
      {type:"90", label:"Vers la droite"},
      {type:"180", label:"Vers le bas"},
      {type:"270", label:"Vers la gauche"},
    ], String(o.angle||0), v=>{ o.angle = parseInt(v,10); render(); }));
  }

  inspectorBody.appendChild(textareaField("Description (affichée si le joueur meurt à cause de cet objet)", o.description, v=>{ o.description=v; }));

  // ---- Trigger ----
  if(!o.trap) o.trap = {};
  const trigBox = el("div",{class:"sectionBox"});
  trigBox.appendChild(el("div",{class:"sectionTitle", text:"Déclencheur (trigger)"}));
  const trigType = o.trap.trigger ? o.trap.trigger.type : "NONE";
  trigBox.appendChild(selectField("Type", TRIGGER_TYPES, trigType, v=>{
    if(v==="NONE"){ delete o.trap.trigger; } else { o.trap.trigger = Object.assign({type:v}, o.trap.trigger&&o.trap.trigger.type===v?o.trap.trigger:{}); }
    renderInspector();
  }));
  if(o.trap.trigger){
    if(o.trap.trigger.type==="ON_TIMER"){
      trigBox.appendChild(numField("Délai depuis le début du niveau (ms)", o.trap.trigger.delay||0, v=>{ o.trap.trigger.delay=v; }));
    } else if(o.trap.trigger.type==="ON_ATTEMPT"){
      trigBox.appendChild(numField("Nombre de tentatives minimum", o.trap.trigger.count||1, v=>{ o.trap.trigger.count=v; }));
    } else if(o.trap.trigger.type==="ON_ENTER"){
      trigBox.appendChild(selectField("Sens d'entrée requis", [
        {type:"any",label:"Peu importe"},{type:"left",label:"Par la gauche"},{type:"right",label:"Par la droite"},
        {type:"top",label:"Par le haut"},{type:"bottom",label:"Par le bas"},
      ], o.trap.trigger.fromSide||"any", v=>{ o.trap.trigger.fromSide = v==="any" ? undefined : v; }));
    }
  }
  inspectorBody.appendChild(trigBox);

  // ---- Action ----
  const actBox = el("div",{class:"sectionBox"});
  actBox.appendChild(el("div",{class:"sectionTitle", text:"Action (sur cet objet)"}));
  const actType = o.trap.action ? o.trap.action.type : "NONE";
  actBox.appendChild(selectField("Type", ACTION_TYPES, actType, v=>{
    o.trap.action = v==="NONE" ? {type:"NONE"} : {type:v};
    renderInspector();
  }));
  const actParamsWrap = el("div",{});
  actBox.appendChild(actParamsWrap);
  if(o.trap.action) renderActionParams(actParamsWrap, o.trap.action, ()=>{});
  inspectorBody.appendChild(actBox);

  // ---- Cascade (then) ----
  const casBox = el("div",{class:"sectionBox"});
  casBox.appendChild(el("div",{class:"sectionTitle", text:"Cascade (déclenche d'autres objets, la scène ou le joueur)"}));
  const others = allCascadeTargets(o.id);
  if(!o.trap.then) o.trap.then = [];
  if(!o.trap.then.length){
    casBox.appendChild(el("p",{class:"empty", text:"Aucun lien. Utilise \"Lier →\" ci-dessous (objets uniquement) ou ajoute une entrée dans la liste (objets, SCENE, PLAYER)."}));
  }
  o.trap.then.forEach((link, idx)=>{
    const row = el("div",{class:"thenRow"});
    const top = el("div",{class:"rowTop"},
      el("span",{class:"idTag", text:"→ "+link.target}),
      el("button",{class:"miniBtn", text:"✕", onclick:()=>{ o.trap.then.splice(idx,1); renderInspector(); render(); }})
    );
    row.appendChild(top);
    row.appendChild(selectField("Cible", others.map(id=>({type:id,label:id})), link.target, v=>{ link.target=v; link.action={type:"NONE"}; renderInspector(); render(); }));
    row.appendChild(numField("Délai (ms)", link.delay||0, v=>{ link.delay=v; }));
    if(!link.action) link.action = {type:"NONE"};
    row.appendChild(selectField("Action sur la cible", actionTypesForTarget(link.target), link.action.type, v=>{ link.action={type:v}; renderInspector(); }));
    const paramsWrap = el("div",{});
    row.appendChild(paramsWrap);
    renderActionParams(paramsWrap, link.action, ()=>{});
    casBox.appendChild(row);
  });
  const addBtn = el("button",{class:"addBtn", text:"+ Ajouter une cascade (liste)", onclick:()=>{
    if(!others.length) return;
    o.trap.then.push({ target:others[0], delay:200, action:{type:"NONE"} });
    renderInspector();
  }});
  casBox.appendChild(addBtn);
  const linkBtn = el("button",{class:"addBtn", text: (mode==="link"&&linkSourceId===o.id) ? "Annuler le lien…" : "🔗 Lier → (clique la cible sur la scène)", onclick:()=>{
    if(mode==="link" && linkSourceId===o.id){ mode="select"; linkSourceId=null; }
    else { mode="link"; linkSourceId=o.id; }
    render();
  }});
  casBox.appendChild(linkBtn);
  inspectorBody.appendChild(casBox);
}

/* ---------------------------- Toolbar : dupliquer / supprimer ---------------------------- */
btnDuplicate.addEventListener("click", ()=>{
  const o = selectedObj();
  if(!o) return;
  const copy = JSON.parse(JSON.stringify(o));
  copy.id = uniqueId(o.kind);
  copy.x = Math.min(W-copy.w, o.x+16); copy.y = Math.min(H-copy.h, o.y+16);
  curLevel().objects.push(copy);
  selectedId = copy.id;
  renderInspector(); render();
});
btnDelete.addEventListener("click", ()=>{
  const o = selectedObj();
  if(!o || isLocked(o.id)) return;
  curLevel().objects = curLevel().objects.filter(x=>x.id!==o.id);
  for(const other of curLevel().objects){
    if(other.trap && other.trap.then) other.trap.then = other.trap.then.filter(l=>l.target!==o.id);
  }
  selectedId = null;
  renderInspector(); render();
});
window.addEventListener("keydown", (e)=>{
  if(playRunning) return;
  if((e.key==="Delete" || e.key==="Backspace") && selectedObj() && !isLocked(selectedObj().id) && document.activeElement.tagName!=="INPUT" && document.activeElement.tagName!=="TEXTAREA"){
    e.preventDefault(); btnDelete.click();
  }
  if(e.key==="Escape"){ mode="select"; placeKind=null; linkSourceId=null; refreshPaletteActive(); render(); }
});

/* ---------------------------- Grille ---------------------------- */
document.getElementById("chkGrid").addEventListener("change", (e)=>{ gridOn = e.target.checked; render(); });

/* ---------------------------- Import / Export JSON (un seul niveau) ---------------------------- */
document.getElementById("btnExport").addEventListener("click", ()=>{
  const blob = new Blob([JSON.stringify(level, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeName = (level.id || "niveau").replace(/[^a-z0-9_-]+/gi, "-");
  a.href = url; a.download = safeName + ".json";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});
document.getElementById("btnImport").addEventListener("click", ()=> document.getElementById("fileImport").click());
document.getElementById("fileImport").addEventListener("change", (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const parsed = JSON.parse(reader.result);
      /* Accepte un niveau seul (format courant), ou par confort un ancien
         export multi-niveaux ({levels:[...]} ou tableau) dont on ne reprend
         que le premier niveau. */
      let imported;
      if(Array.isArray(parsed)) imported = parsed[0];
      else if(parsed.levels) imported = parsed.levels[0];
      else imported = parsed;
      if(!imported || !imported.objects) throw new Error("format de niveau inattendu");
      level = Object.assign(makeEmptyLevel(imported.id||null, imported.name||"Niveau"), imported);
      selectedId = null; mode="select"; placeKind=null; linkSourceId=null;
      renderLevelMeta(); renderInspector(); refreshPaletteActive(); fitView(); render();
    }catch(err){ alert("Fichier JSON invalide : "+err.message); }
  };
  reader.readAsText(file);
  e.target.value = "";
});
document.getElementById("btnResetLevel").addEventListener("click", () => {
  if(!confirm("Tout réinitialiser ? Le niveau en cours sera perdu (pense à l'exporter avant si besoin).")) return;
  level = makeEmptyLevel(null, "Niveau 1");
  selectedId = null; mode="select"; placeKind=null; linkSourceId=null;
  setInspectorOpen(false);
  renderLevelMeta(); renderInspector(); refreshPaletteActive(); fitView(); render();
});

/* ---------------------------- Fenêtre Firebase ---------------------------- */
const fbBackdrop = document.getElementById("fbBackdrop");
const fbModal = document.getElementById("fbModal");
function openFirebaseModal(){
  fbBackdrop.classList.add("show"); fbModal.classList.add("show");
  refreshFirebaseLevelList();
}
function closeFirebaseModal(){ fbBackdrop.classList.remove("show"); fbModal.classList.remove("show"); }
document.getElementById("btnFirebase").addEventListener("click", openFirebaseModal);
document.getElementById("fbModalClose").addEventListener("click", closeFirebaseModal);
fbBackdrop.addEventListener("click", closeFirebaseModal);

document.getElementById("fbSaveBtn").addEventListener("click", async ()=>{
  const status = document.getElementById("fbStatusSelect").value;
  const msg = document.getElementById("fbSaveStatus");
  msg.textContent = "Sauvegarde en cours…"; msg.className = "fbStatusMsg";
  try{
    await firebaseSaveLevel(level, status);
    msg.textContent = "Niveau \""+level.name+"\" sauvegardé ("+status+")."; msg.className = "fbStatusMsg ok";
    refreshFirebaseLevelList();
  }catch(err){
    msg.textContent = "Échec : " + err.message; msg.className = "fbStatusMsg error";
  }
});

document.getElementById("fbRefreshBtn").addEventListener("click", refreshFirebaseLevelList);

async function refreshFirebaseLevelList(){
  const listEl = document.getElementById("fbLevelList");
  listEl.innerHTML = '<p class="empty">Chargement…</p>';
  try{
    const levels = await firebaseListLevels();
    const ids = Object.keys(levels);
    if(!ids.length){ listEl.innerHTML = '<p class="empty">Aucun niveau sur Firebase pour l\'instant.</p>'; return; }
    listEl.innerHTML = "";
    for(const id of ids){
      const lv = levels[id];
      const row = document.createElement("div");
      row.className = "fbLevelRow";
      const status = lv.status === "FINAL" ? "FINAL" : "PRODUCTION";
      row.innerHTML =
        '<div><div class="fbName">'+(lv.name||id)+'</div>'+
        '<div class="fbMeta">'+id+'</div></div>'+
        '<div style="display:flex;align-items:center;gap:8px;">'+
        '<span class="fbBadge '+status+'">'+status+'</span>'+
        '<button class="tbtn" data-load-id="'+id+'">Charger</button>'+
        '</div>';
      row.querySelector("[data-load-id]").addEventListener("click", async ()=>{
        try{
          const loaded = await firebaseLoadLevel(id);
          level = Object.assign(makeEmptyLevel(loaded.id||id, loaded.name||"Niveau"), loaded);
          selectedId = null; mode="select"; placeKind=null; linkSourceId=null;
          renderLevelMeta(); renderInspector(); refreshPaletteActive(); fitView(); render();
          closeFirebaseModal();
        }catch(err){ alert("Échec du chargement : " + err.message); }
      });
      listEl.appendChild(row);
    }
  }catch(err){
    listEl.innerHTML = '<p class="empty">Erreur : '+err.message+'</p>';
  }
}

/* =========================================================================
   MODE TEST — réutilise le moteur du jeu (trigger/action/cascade + physique)
   directement sur le niveau en cours d'édition, pour un aller-retour immédiat.
   ========================================================================= */
let playRunning = false;
let P = null; // état du joueur en mode test
let playObjects = [], playObjectsById = {}, playTimers = [], playNow = 0, playMode="playing", playLastCause=null;
const playInput = { left:false, right:false, jumpQueued:false };

function playScheduleTimer(ms, fn){ playTimers.push({ fireAt: playNow+ms, fn }); }
function playProcessTimers(){
  if(!playTimers.length) return;
  const due = playTimers.filter(t=>t.fireAt<=playNow);
  if(!due.length) return;
  playTimers = playTimers.filter(t=>t.fireAt>playNow);
  for(const t of due) t.fn();
}
function playOverlap(a,b){ return a.x<b.x+b.w && a.x+a.w>b.x && a.y<b.y+b.h && a.y+a.h>b.y; }
function approach(cur, target, maxDelta){
  if(cur < target) return Math.min(cur+maxDelta, target);
  if(cur > target) return Math.max(cur-maxDelta, target);
  return cur;
}
function playApplyAction(obj, action){
  switch(action.type){
    case "FALL":
      obj.state="shaking"; obj.fallSpeed=action.fallSpeed||260;
      playScheduleTimer(action.shakeMs||300, ()=>{ obj.state="falling"; obj.solid=false; obj.vy=0; playFireCascade(obj); });
      break;
    case "DISAPPEAR": obj.visible=false; obj.solid=false; obj.hazard=false; playFireCascade(obj); break;
    case "REVEAL":
      /* Rend l'objet visible et restaure sa solidité d'origine — sans
         jamais forcer "hazard" à true : le danger dépend uniquement de ce
         qui est coché dans "Dangereux au contact" pour CET objet. Un pic
         caché est configuré hazard=true dès le départ (mais reste inoffensif
         tant qu'il est invisible, la vérification de dégât exige les deux) ;
         un mur normal reste hazard=false et redevient donc un mur normal. */
      playScheduleTimer(action.delay||0, ()=>{
        const src = playObjectsById[obj.id];
        obj.visible=true;
        obj.solid = src ? !!src.solid : obj.solid;
        obj.state="revealed";
        playFireCascade(obj);
      });
      break;
    case "OPEN": obj.solid=false; obj.visible=false; playFireCascade(obj); break;
    case "ACTIVATE": obj.state="activated"; playFireCascade(obj); break;
    case "APPEAR_TEMP": obj.visible=true; obj.solid=true; playScheduleTimer(action.ms||500, ()=>{ obj.visible=false; obj.solid=false; }); playFireCascade(obj); break;
    case "DISABLE": return;
    case "MOVE":
      /* Chaque MOVE ne pilote QUE l'axe correspondant à sa direction
         (gauche/droite => X, haut/bas => Y), sans toucher à l'autre axe —
         deux MOVE sur des axes différents s'additionnent donc en diagonale
         au lieu de s'annuler. Un second MOVE sur le MÊME axe remplace
         proprement le premier (comportement attendu). */
      {
        const speed = action.speed!=null?action.speed:100;
        const dir = action.direction||"right";
        const axis = (dir==="left"||dir==="right") ? "x" : "y";
        const target = axis==="x" ? (dir==="left"?-speed:speed) : (dir==="up"?-speed:speed);
        const accel = action.acceleration || 0;
        const prevV = axis==="x" ? (obj.moveX ? obj.moveX.v : 0) : (obj.moveY ? obj.moveY.v : 0);
        const mover = { target, accel, v: accel ? prevV : target };
        if(axis==="x") obj.moveX = mover; else obj.moveY = mover;
        obj.state = "moving";
        if(action.duration){
          playScheduleTimer(action.duration, ()=>{
            if(axis==="x") obj.moveX = null; else obj.moveY = null;
            if(!obj.moveX && !obj.moveY) obj.state = "idle";
          });
        }
      }
      playFireCascade(obj);
      break;
    case "ROTATE":
      obj.state="rotating"; obj.angle=obj.angle||0;
      obj.rotateSpeed = (action.direction==="ccw"?-1:1) * (action.speed!=null?action.speed:90);
      if(action.duration){ playScheduleTimer(action.duration, ()=>{ obj.state="idle"; obj.rotateSpeed=0; }); }
      playFireCascade(obj);
      break;
    default: playFireCascade(obj);
  }
}
/* Actions sur les cibles spéciales SCENE et PLAYER (cf. SCENE_ACTION_TYPES /
   PLAYER_ACTION_TYPES). Séparées de playApplyAction car ni la scène ni le
   joueur ne sont des objets du niveau. */
function applySceneAction(action){
  if(action.type==="SET_GRAVITY"){
    currentGravity = action.value!=null ? action.value : DEFAULT_GRAVITY;
  }
}
function applyPlayerAction(action){
  if(action.type==="CHANGE_WIDTH"){
    const newW = action.value!=null ? action.value : 26;
    P.x += (P.w-newW)/2; // recentre horizontalement pour éviter un saut brusque
    P.w = newW;
  } else if(action.type==="CHANGE_HEIGHT"){
    const newH = action.value!=null ? action.value : 38;
    P.y += (P.h-newH); // garde les pieds au même endroit (ancre en bas)
    P.h = newH;
  } else if(action.type==="MOVE"){
    const speed = action.speed!=null?action.speed:100;
    const dir = action.direction||"right";
    const axis = (dir==="left"||dir==="right") ? "x" : "y";
    const target = axis==="x" ? (dir==="left"?-speed:speed) : (dir==="up"?-speed:speed);
    const accel = action.acceleration || 0;
    const prevV = axis==="x" ? (P.moveX?P.moveX.v:0) : (P.moveY?P.moveY.v:0);
    const mover = { target, accel, v: accel?prevV:target };
    if(axis==="x") P.moveX=mover; else P.moveY=mover;
    if(action.duration){
      playScheduleTimer(action.duration, ()=>{ if(axis==="x") P.moveX=null; else P.moveY=null; });
    }
  }
}
function playFireCascade(obj){
  /* Chaque lien de cascade s'applique indépendamment, même si la cible a
     déjà reçu une action d'un autre lien (ex : un premier lien qui la fait
     apparaître, un second qui la fait bouger). `triggered` sert seulement à
     empêcher le déclencheur PROPRE de la cible de se redéclencher tout
     seul — il ne doit jamais empêcher une cascade explicite de s'appliquer. */
  const def = playObjectsById[obj.id];
  if(!def || !def.trap || !def.trap.then) return;
  for(const link of def.trap.then){
    playScheduleTimer(link.delay||0, ()=>{
      if(link.target==="SCENE"){ applySceneAction(link.action); return; }
      if(link.target==="PLAYER"){ applyPlayerAction(link.action); return; }
      const target = playObjects.find(o=>o.id===link.target);
      if(target){ target.triggered=true; playApplyAction(target, link.action); }
    });
  }
}
/* Détermine de quel(s) côté(s) une boîte (prevBox) qui ne chevauchait pas
   `obj` est entrée en chevauchement dans `obj`, en comparant à sa position
   après déplacement (newBox). Sert au trigger ON_ENTER avec sens requis. */
function enteredFromSides(prevBox, newBox, obj){
  const sides = [];
  if(prevBox.x+prevBox.w <= obj.x && newBox.x+newBox.w > obj.x) sides.push("left");
  if(prevBox.x >= obj.x+obj.w && newBox.x < obj.x+obj.w) sides.push("right");
  if(prevBox.y+prevBox.h <= obj.y && newBox.y+newBox.h > obj.y) sides.push("top");
  if(prevBox.y >= obj.y+obj.h && newBox.y < obj.y+obj.h) sides.push("bottom");
  return sides;
}
function playCheckTrigger(obj){
  const def = playObjectsById[obj.id];
  const t = def.trap && def.trap.trigger;
  if(!t) return false;
  switch(t.type){
    case "ON_LAND": return P.justLandedOn===obj.id;
    case "ON_ENTER": {
      if(!playOverlap(P, obj)) return false;
      if(!t.fromSide) return true;
      if(playPrevBox && playOverlap(playPrevBox, obj)) return false; // déjà dedans, pas une "entrée"
      const sides = playPrevBox ? enteredFromSides(playPrevBox, P, obj) : [];
      return sides.includes(t.fromSide);
    }
    case "ON_JUMP": return P.justJumped && playOverlap(P, obj);
    case "ON_TIMER": return playNow >= (t.delay||0);
    case "ON_ATTEMPT": return playAttempts >= (t.count||1);
    default: return false;
  }
}
let playAttempts = 0;
let walkPhase = 0;
let showHiddenInPlay = false;
function playBuildLevel(){
  const lvl = curLevel();
  playObjects = JSON.parse(JSON.stringify(lvl.objects)).map(o=>Object.assign({visible:true,hazard:!!o.hazard,triggered:false,state:"idle"}, o));
  playObjectsById = {};
  for(const o of lvl.objects) playObjectsById[o.id]=o;
  P = { x:lvl.playerStart.x, y:lvl.playerStart.y, w:26, h:38, vx:0, vy:0, grounded:false, groundedOn:null,
    prevGroundedOn:null, justLandedOn:null, justJumped:false, lastBump:null, lastGroundY:null, moveX:null, moveY:null, facing:1 };
  playTimers=[]; playNow=0; playMode="playing"; playLastCause=null; walkPhase=0; playPrevBox=null;
  currentGravity = lvl.gravity!=null ? lvl.gravity : DEFAULT_GRAVITY;
  hidePlayMsg();
}
/* Boîte de collision effective d'un objet : pour un objet qui tourne, on
   utilise le rectangle aligné sur les axes qui englobe exactement sa forme
   pivotée (il grandit/rétrécit avec l'angle). C'est une approximation
   simple (pas une vraie collision de rectangle orienté), mais elle garde
   la physique cohérente avec le rendu visuel : le joueur peut monter sur
   une plateforme en rotation et sa hauteur d'appui suit l'inclinaison. */
function effectiveBox(o){
  if(o.angle){
    const rad = o.angle*Math.PI/180;
    const hw = o.w/2, hh = o.h/2;
    const bhw = Math.abs(hw*Math.cos(rad)) + Math.abs(hh*Math.sin(rad));
    const bhh = Math.abs(hw*Math.sin(rad)) + Math.abs(hh*Math.cos(rad));
    const cx = o.x+hw, cy = o.y+hh;
    return { x:cx-bhw, y:cy-bhh, w:bhw*2, h:bhh*2 };
  }
  return o;
}
function playResolve(dt){
  /* fallSign = sens de la gravité actuelle (1 = normale, -1 = inversée).
     Toute la résolution ci-dessous est symétrique par rapport à ce signe :
     avec une gravité inversée, "atterrir" veut dire se coller au DESSOUS
     d'une plateforme (le sol est au plafond), et le rattrapage de saut
     s'applique vers une plateforme plus basse (dans le sens opposé à la
     gravité) plutôt que plus haute. */
  const fallSign = currentGravity >= 0 ? 1 : -1;
  const prevBottom=P.y+P.h, prevTop=P.y;
  P.x += P.vx*dt; P.y += P.vy*dt;
  P.grounded=false; P.groundedOn=null;
  for(const o of playObjects){
    /* Un objet invisible ne bloque pas physiquement par défaut (sinon un
       piège qu'on a réussi à éviter continuerait à gêner le joueur) — sauf
       si "Bloquant même invisible" est explicitement coché. */
    if(!o.solid) continue;
    if(o.visible===false && !o.solidWhenHidden) continue;
    const box = effectiveBox(o);
    if(!playOverlap(P,box)) continue;

    if(fallSign>0){
      if(P.vy>=0 && prevBottom<=box.y+2){ P.y=box.y-P.h; P.vy=0; P.grounded=true; P.groundedOn=o.id; P.lastGroundY=box.y; continue; }
      if(P.vy<0 && prevTop>=box.y+box.h-2){ P.y=box.y+box.h; P.vy=0; P.lastBump={id:o.id,t:playNow}; continue; }
    } else {
      if(P.vy<=0 && prevTop>=box.y+box.h-2){ P.y=box.y+box.h; P.vy=0; P.grounded=true; P.groundedOn=o.id; P.lastGroundY=box.y+box.h; continue; }
      if(P.vy>0 && prevBottom<=box.y+2){ P.y=box.y-P.h; P.vy=0; P.lastBump={id:o.id,t:playNow}; continue; }
    }

    const overlapX = Math.min(P.x+P.w,box.x+box.w)-Math.max(P.x,box.x);
    const overlapY = Math.min(P.y+P.h,box.y+box.h)-Math.max(P.y,box.y);
    if(overlapX<overlapY){
      /* Aide au pas : mesurée par rapport à la position AVANT le déplacement
         de cette image, et seulement pour grimper vers une plateforme
         nettement plus proche du "plafond effectif" que celle qu'on vient
         de quitter (un saut à peine trop court) — jamais pour boucher un
         petit trou qu'on traverse simplement en marchant. */
      let shortfall, targetIsRaised, movingTowardSurface;
      if(fallSign>0){
        shortfall = prevBottom - box.y;
        targetIsRaised = P.lastGroundY==null || box.y < P.lastGroundY - 2;
        movingTowardSurface = P.vy>=0;
      } else {
        shortfall = (box.y+box.h) - prevTop;
        targetIsRaised = P.lastGroundY==null || (box.y+box.h) > P.lastGroundY + 2;
        movingTowardSurface = P.vy<=0;
      }
      if(targetIsRaised && shortfall>0 && shortfall<=STEP_UP && movingTowardSurface){
        if(fallSign>0){ P.y=box.y-P.h; P.lastGroundY=box.y; } else { P.y=box.y+box.h; P.lastGroundY=box.y+box.h; }
        P.vy=0; P.grounded=true; P.groundedOn=o.id;
      }
      else { if(P.x<box.x) P.x-=overlapX; else P.x+=overlapX; P.vx=0; }
    } else {
      if(fallSign>0){
        if(P.y<box.y){ P.y-=overlapY; P.vy=0; P.grounded=true; P.groundedOn=o.id; P.lastGroundY=box.y; }
        else { P.y+=overlapY; P.vy=0; P.lastBump={id:o.id,t:playNow}; }
      } else {
        if(P.y+P.h>box.y+box.h){ P.y+=overlapY; P.vy=0; P.grounded=true; P.groundedOn=o.id; P.lastGroundY=box.y+box.h; }
        else { P.y-=overlapY; P.vy=0; P.lastBump={id:o.id,t:playNow}; }
      }
    }
  }
  if(P.x<0) P.x=0; if(P.x+P.w>W) P.x=W-P.w;
}
let playPrevBox = null;
function playUpdate(dt){
  playNow += dt*1000; playProcessTimers();
  playPrevBox = { x:P.x, y:P.y, w:P.w, h:P.h };

  /* Objets animés, avant la résolution des collisions (le joueur se tient
     sur la position à jour d'une plateforme mobile ce tour-ci). */
  for(const o of playObjects){
    o._lastDX = 0; o._lastDY = 0;
    if(o.state==="falling"){
      o.y += o.fallSpeed*dt; if(o.y>H+100){ o.visible=false; o.dead=true; }
    }
    /* moveX et moveY sont deux "moteurs" indépendants (un par axe) : une
       translation horizontale et une translation verticale peuvent tourner
       EN PARALLÈLE sur le même objet (ex : MOVE droite pendant 1000ms +
       MOVE haut décalé de 200ms => une diagonale), au lieu de s'écraser
       l'une l'autre. */
    if(o.moveX || o.moveY){
      let dx=0, dy=0;
      if(o.moveX){
        o.moveX.v = o.moveX.accel ? approach(o.moveX.v, o.moveX.target, o.moveX.accel*dt) : o.moveX.target;
        dx = o.moveX.v*dt;
      }
      if(o.moveY){
        o.moveY.v = o.moveY.accel ? approach(o.moveY.v, o.moveY.target, o.moveY.accel*dt) : o.moveY.target;
        dy = o.moveY.v*dt;
      }
      o.x += dx; o.y += dy; o._lastDX += dx; o._lastDY += dy;
    }
    if(o.state==="rotating"){
      o.angle = (o.angle||0) + (o.rotateSpeed||0)*dt;
    }
  }

  P.vx = ((playInput.right?1:0)-(playInput.left?1:0)) * MOVE_SPEED;
  if(P.vx>0) P.facing=1; else if(P.vx<0) P.facing=-1;
  walkPhase += Math.abs(P.vx)*dt*0.15;
  P.justJumped=false;
  if(playInput.jumpQueued && P.grounded){
    /* Le saut pousse toujours à l'OPPOSÉ du sens de la gravité actuelle :
       avec une gravité inversée (on est collé au plafond), sauter pousse
       vers le bas, pas vers le haut. */
    P.vy = currentGravity>=0 ? JUMP_VELOCITY : -JUMP_VELOCITY;
    P.grounded=false; P.groundedOn=null; P.justJumped=true;
  }
  playInput.jumpQueued=false;

  /* Impulsion externe (action MOVE ciblant PLAYER, cf. applyPlayerAction) :
     s'ajoute au déplacement piloté par les touches, sans jamais l'écraser —
     même logique à deux axes indépendants que pour les objets. */
  if(P.moveX){
    P.moveX.v = P.moveX.accel ? approach(P.moveX.v, P.moveX.target, P.moveX.accel*dt) : P.moveX.target;
    P.vx += P.moveX.v;
  }
  if(P.moveY){
    P.moveY.v = P.moveY.accel ? approach(P.moveY.v, P.moveY.target, P.moveY.accel*dt) : P.moveY.target;
    P.vy += P.moveY.v;
  }

  /* Sous-pas physiques : à 240px/s et 60 img/s, une image déplace le joueur
     de 4px, et son corps fait 26px de large — l'écart réel à traverser sans
     aucun contact (largeur du trou moins largeur du joueur) est souvent
     plus petit qu'un seul pas, donc franchi d'un coup avant que la gravité
     n'ait eu le temps de s'accumuler. Recalculer la gravité et la collision
     plusieurs fois par image (au lieu d'une fois avec le dt complet) donne
     une chute d'apparence continue et détecte correctement les petits trous. */
  const SUBSTEPS = 4;
  const subDt = dt / SUBSTEPS;
  for(let s=0; s<SUBSTEPS; s++){
    P.vy += currentGravity*subDt;
    if(P.vy>MAX_FALL) P.vy=MAX_FALL;
    if(P.vy<-MAX_FALL) P.vy=-MAX_FALL;
    playResolve(subDt);
  }

  /* Portage par une plateforme mobile. */
  if(P.grounded && P.groundedOn){
    const platform = playObjects.find(o=>o.id===P.groundedOn);
    if(platform && (platform._lastDX || platform._lastDY)){
      P.x += platform._lastDX; P.y += platform._lastDY;
    }
  }

  P.justLandedOn = (P.grounded && P.groundedOn!==P.prevGroundedOn) ? P.groundedOn : null;
  P.prevGroundedOn = P.grounded ? P.groundedOn : null;
  for(const o of playObjects){
    if(o.triggered) continue;
    if(playCheckTrigger(o)){ o.triggered=true; playApplyAction(o, playObjectsById[o.id].trap.action); }
  }
  const lvl = curLevel();
  if(playOverlap(P, lvl.exit)){
    playMode="won";
    showPlayMsg("⭐ Niveau terminé ! Relance automatique dans 2 secondes…");
    setTimeout(()=>{ if(playRunning) playBuildLevel(); }, 2000);
    return;
  }
  if(P.y>H+60){ playDeath(null); return; }
  for(const o of playObjects){ if(o.hazard && o.visible!==false && playOverlap(P,o)){ playDeath(o); return; } }
}
function playDeath(obj){
  playMode="dead"; playAttempts++;
  let cause=obj;
  if(!cause && P.lastBump && (playNow-P.lastBump.t)<1500) cause = playObjectsById[P.lastBump.id];
  playLastCause = cause ? (cause.description||"Un piège t'a eu.") : "Tu es tombé dans le vide.";
  showPlayMsg("💀 "+playLastCause+" (rejoue automatiquement…)");
  setTimeout(()=>{ if(playRunning){ playBuildLevel(); } }, 1100);
}
function drawPlayObject(o){
  const invisible = (o.visible===false);
  if(invisible && !showHiddenInPlay) return;
  const shakeOff = (o.state==="shaking") ? Math.sin(playNow*0.06)*2 : 0;
  ctx.save(); ctx.translate(shakeOff,0);
  if(o.angle){
    const cx=o.x+o.w/2, cy=o.y+o.h/2;
    ctx.translate(cx,cy); ctx.rotate(o.angle*Math.PI/180); ctx.translate(-cx,-cy);
  }
  if(invisible) ctx.globalAlpha = 0.4;
  switch(o.kind){
    case "static": case "decoy": drawBrick(o.x,o.y,o.w,o.h); break;
    case "falling":
      drawBrick(o.x,o.y,o.w,o.h);
      if(o.state==="shaking"||o.state==="falling"){ ctx.strokeStyle="rgba(40,20,10,.55)"; ctx.lineWidth=1.5;
        ctx.beginPath(); ctx.moveTo(o.x+o.w*0.32,o.y+2); ctx.lineTo(o.x+o.w*0.45,o.y+o.h*0.6); ctx.lineTo(o.x+o.w*0.38,o.y+o.h-2); ctx.stroke(); }
      break;
    case "gate": drawStoneBrick(o.x,o.y,o.w,o.h); break;
    case "blocker": drawBrick(o.x,o.y,o.w,o.h); ctx.strokeStyle="rgba(224,69,92,.55)"; ctx.lineWidth=2; ctx.strokeRect(o.x+1,o.y+1,o.w-2,o.h-2); break;
    case "hidden_spike":
      if(o.hazard){ ctx.fillStyle="#e0455c"; for(let i=0;i<3;i++){ const sx=o.x+i*(o.w/3);
        ctx.beginPath(); ctx.moveTo(sx,o.y+o.h); ctx.lineTo(sx+o.w/6,o.y); ctx.lineTo(sx+o.w/3,o.y+o.h); ctx.closePath(); ctx.fill(); } }
      else if(invisible){ ctx.fillStyle="rgba(224,69,92,.35)"; for(let i=0;i<3;i++){ const sx=o.x+i*(o.w/3);
        ctx.beginPath(); ctx.moveTo(sx,o.y+o.h); ctx.lineTo(sx+o.w/6,o.y); ctx.lineTo(sx+o.w/3,o.y+o.h); ctx.closePath(); ctx.fill(); } }
      break;
    case "door":
      drawDoorShape(o.x,o.y,o.w,o.h, "#3d5af1", "#eef0ff", "#1f2d8a");
      break;
    case "button":
      drawStoneBrick(o.x,o.y,o.w,o.h);
      { const cx=o.x+o.w/2, cy=o.y+o.h/2, r=Math.min(o.w,o.h)*0.28;
        ctx.fillStyle = o.state==="activated" ? "#4f8f6a" : "#8a6a3a"; ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill(); }
      break;
    case "sensor":
      ctx.fillStyle="rgba(61,90,241,.18)"; ctx.fillRect(o.x,o.y,o.w,o.h);
      ctx.strokeStyle="#3d5af1"; ctx.setLineDash([4,3]); ctx.lineWidth=1.5; ctx.strokeRect(o.x,o.y,o.w,o.h); ctx.setLineDash([]);
      break;
  }
  if(invisible){
    ctx.globalAlpha = 1;
    ctx.strokeStyle="rgba(61,90,241,.7)"; ctx.setLineDash([4,3]); ctx.lineWidth=1.5;
    ctx.strokeRect(o.x+0.5,o.y+0.5,o.w-1,o.h-1); ctx.setLineDash([]);
  }
  ctx.restore();
}
/* Personnage joueur : un simple bonhomme-bâton (tête ronde, tronc, bras,
   jambes) qui s'anime à la marche et prend une pose différente en l'air —
   dessiné en coordonnées LOCALES (origine = centre de la boîte du joueur,
   déjà translatée/retournée par l'appelant selon P.facing). */
function drawStickFigure(w, h, grounded, phase, dead, speedFrac){
  const x = -w/2, y = -h/2;
  const headR = 5;
  const midX = x + w/2;
  const headCY = y + headR + 1;
  const shoulderY = y + headR*2 + 4;
  const hipY = y + h*0.58;
  const footY = y + h;
  const amp = grounded ? (speedFrac!=null?speedFrac:1) : 1;
  const swing = grounded ? Math.sin(phase)*amp : 0;
  const legOffset = grounded ? swing*8 : 0;
  const armOffset = grounded ? -swing*7 : 0;

  ctx.strokeStyle = dead ? "#b8bccb" : "#2a2d3d";
  ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round";

  // tête
  ctx.beginPath(); ctx.arc(midX, headCY, headR, 0, Math.PI*2);
  ctx.fillStyle = dead ? "#d7d9e4" : "#3d5af1"; ctx.fill(); ctx.stroke();

  // tronc
  ctx.beginPath(); ctx.moveTo(midX, shoulderY); ctx.lineTo(midX, hipY); ctx.stroke();

  // bras
  ctx.beginPath(); ctx.moveTo(midX, shoulderY+2); ctx.lineTo(midX-8, shoulderY+13+armOffset); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(midX, shoulderY+2); ctx.lineTo(midX+8, shoulderY+13-armOffset); ctx.stroke();

  // jambes
  if(grounded){
    ctx.beginPath(); ctx.moveTo(midX, hipY); ctx.lineTo(midX-6-legOffset, footY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(midX, hipY); ctx.lineTo(midX+6+legOffset, footY); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.moveTo(midX, hipY); ctx.lineTo(midX-9, hipY+8); ctx.lineTo(midX-5, footY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(midX, hipY); ctx.lineTo(midX+9, hipY+8); ctx.lineTo(midX+5, footY); ctx.stroke();
  }
}
/* Ne renvoie que la zone jouable (entre les murs de bordure) : tout ce qui
   est hors de cette zone (les murs eux-mêmes, et au-delà) reste en noir —
   comme si les bornes étaient le cadre même de l'écran. Si un niveau n'a
   pas (ou plus) ses murs par défaut, on retombe sur le monde 800x450 entier. */
function computePlayArea(){
  const top = playObjects.find(o=>o.id==="_boundTop");
  const left = playObjects.find(o=>o.id==="_boundLeft");
  const right = playObjects.find(o=>o.id==="_boundRight");
  const x0 = left ? left.x+left.w : 0;
  const y0 = top ? top.y+top.h : 0;
  const x1 = right ? right.x : W;
  return { x:x0, y:y0, w:Math.max(1,x1-x0), h:Math.max(1,H-y0) };
}
function renderPlay(){
  ctx.save();
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle = "#000"; ctx.fillRect(0,0,canvas.width,canvas.height);
  const area = computePlayArea();
  const s = Math.min(canvas.width/area.w, canvas.height/area.h) || 1;
  const ox = (canvas.width - area.w*s)/2 - area.x*s;
  const oy = (canvas.height - area.h*s)/2 - area.y*s;
  ctx.setTransform(s,0,0,s, ox, oy);
  ctx.beginPath(); ctx.rect(area.x, area.y, area.w, area.h); ctx.clip();

  const grad = ctx.createLinearGradient(0,0,0,H); grad.addColorStop(0,"#eef1fb"); grad.addColorStop(1,"#e2e6f6");
  ctx.fillStyle=grad; ctx.fillRect(0,0,W,H);
  const lvl = curLevel(); const ex = lvl.exit;
  drawDoorShape(ex.x,ex.y,ex.w,ex.h, playMode==="won"?"#2fb380":"#3a9c6c", "#eafff3", "#164a33");
  for(const o of playObjects) drawPlayObject(o);
  ctx.save(); ctx.translate(P.x+P.w/2, P.y+P.h/2); ctx.scale(P.facing, currentGravity<0 ? -1 : 1);
  drawStickFigure(P.w, P.h, P.grounded, walkPhase, playMode==="dead", Math.min(1, Math.abs(P.vx)/80));
  ctx.restore();
  ctx.restore();
}
let playLastTs=null;
function playFrame(ts){
  if(!playRunning) return;
  if(playLastTs===null) playLastTs=ts;
  let dt=(ts-playLastTs)/1000; playLastTs=ts; if(dt>1/30) dt=1/30;
  if(playMode==="playing") playUpdate(dt);
  renderPlay();
  requestAnimationFrame(playFrame);
}
const playOverlayMsg = document.getElementById("playOverlayMsg");
function showPlayMsg(t){ playOverlayMsg.textContent=t; playOverlayMsg.classList.add("show"); }
function hidePlayMsg(){ playOverlayMsg.classList.remove("show"); }

const btnPlay = document.getElementById("btnPlay");
const playControlsEl = document.getElementById("playControls");
function startPlay(){
  /* Important : si le focus clavier est resté sur un champ du panneau de
     propriétés (après avoir édité un paramètre), les flèches gauche/droite
     iraient déplacer le curseur texte / la sélection de ce champ au lieu de
     contrôler le joueur — ce qui donne l'impression que le jeu se bloque.
     On retire explicitement le focus en entrant en mode test. */
  if(document.activeElement && document.activeElement.blur) document.activeElement.blur();
  playRunning = true; playAttempts=0; playLastTs=null;
  playBuildLevel();
  playControlsEl.classList.add("show");
  document.getElementById("showHiddenToggle").classList.add("show");
  btnPlay.textContent = "■ Retour à l'édition";
  document.getElementById("palette").style.display="none";
  document.getElementById("inspector").style.display="none";
  resizeCanvasToContainer();
  requestAnimationFrame(playFrame);
}
function stopPlay(){
  playRunning = false;
  playControlsEl.classList.remove("show");
  document.getElementById("showHiddenToggle").classList.remove("show");
  hidePlayMsg();
  btnPlay.textContent = "▶ Tester le niveau";
  document.getElementById("palette").style.display="";
  document.getElementById("inspector").style.display="";
  resizeCanvasToContainer();
  render();
}
btnPlay.addEventListener("click", ()=>{ if(playRunning) stopPlay(); else startPlay(); });
document.getElementById("chkShowHidden").addEventListener("change", (e)=>{ showHiddenInPlay = e.target.checked; });

window.addEventListener("keydown",(e)=>{
  if(!playRunning) return;
  if(["ArrowLeft","q","Q"].includes(e.key)){ playInput.left=true; e.preventDefault(); }
  if(["ArrowRight","d","D"].includes(e.key)){ playInput.right=true; e.preventDefault(); }
  if(["ArrowUp"," ","w","W","z","Z"].includes(e.key)){ playInput.jumpQueued=true; e.preventDefault(); }
});
window.addEventListener("keyup",(e)=>{
  if(!playRunning) return;
  if(["ArrowLeft","q","Q"].includes(e.key)) playInput.left=false;
  if(["ArrowRight","d","D"].includes(e.key)) playInput.right=false;
});
/* setPointerCapture : seul un vrai relâchement du doigt (pointerup/cancel)
   arrête la commande. Sans ça, le moindre tremblement qui sort du bouton
   déclenche "pointerleave" et coupe la touche alors que le doigt est
   toujours posé — combiné au long-press mobile qui tente de sélectionner
   le texte du bouton, ça donnait l'impression que le jeu se bloquait. */
function bindHold(elm, onDown, onUp){
  elm.addEventListener("pointerdown",(e)=>{
    e.preventDefault();
    if(elm.setPointerCapture) elm.setPointerCapture(e.pointerId);
    onDown();
  });
  elm.addEventListener("pointerup", onUp);
  elm.addEventListener("pointercancel", onUp);
}
bindHold(document.getElementById("btnLeft"), ()=>playInput.left=true, ()=>playInput.left=false);
bindHold(document.getElementById("btnRight"), ()=>playInput.right=true, ()=>playInput.right=false);
bindHold(document.getElementById("btnJump"), ()=>playInput.jumpQueued=true, ()=>{});

/* ---------------------------- Tiroir mobile (palette) ---------------------------- */
function closeMobileDrawers(){
  document.getElementById("palette").classList.remove("open");
}
document.getElementById("btnTogglePalette").addEventListener("click", ()=>{
  setInspectorOpen(false);
  document.getElementById("palette").classList.toggle("open");
});

/* ---------------------------- Démarrage ---------------------------- */
document.getElementById("btnZoomIn").addEventListener("click", ()=>{ setZoom(view.zoom*1.25, canvas.width/2, canvas.height/2); render(); });
document.getElementById("btnZoomOut").addEventListener("click", ()=>{ setZoom(view.zoom/1.25, canvas.width/2, canvas.height/2); render(); });
document.getElementById("btnZoomReset").addEventListener("click", ()=>{ fitView(); render(); });
document.getElementById("btnPanMode").addEventListener("click", (e)=>{
  panModeOn = !panModeOn;
  e.currentTarget.classList.toggle("active", panModeOn);
  canvas.style.cursor = panModeOn ? "grab" : "";
});
/* Redimensionnement de fenêtre "ordinaire" (bureau) : on garde le zoom/pan
   actuels, juste la résolution du canvas qui suit. Un vrai changement
   d'ORIENTATION (portrait <-> paysage, typiquement en tournant le
   téléphone — aussi bien en PWA installée qu'en onglet de navigateur
   normal) recadre la vue à la nouvelle forme de l'écran, sinon le contenu
   resterait mal cadré (trop zoomé, décalé) après la rotation. */
let lastOrientationPortrait = matchMedia("(orientation: portrait)").matches;
function handleViewportChange(){
  const nowPortrait = matchMedia("(orientation: portrait)").matches;
  resizeCanvasToContainer();
  if(nowPortrait !== lastOrientationPortrait){
    lastOrientationPortrait = nowPortrait;
    fitView();
  }
  render();
}
window.addEventListener("resize", handleViewportChange);
window.addEventListener("orientationchange", ()=>{
  // Sur certains navigateurs mobiles, les dimensions ne sont pas encore à
  // jour au moment même de l'événement — un petit délai fiabilise la mesure.
  setTimeout(handleViewportChange, 150);
});

buildPalette();
renderLevelMeta();
renderInspector();
resizeCanvasToContainer();
fitView();
render();
