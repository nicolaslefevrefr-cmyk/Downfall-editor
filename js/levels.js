"use strict";
/* =========================================================================
   Chute Libre — données de niveau (pures, sérialisables)
   Un niveau ne contient QUE des données : géométrie + définitions de pièges
   (trigger/action/cascade). L'écran est fixe, la caméra ne bouge jamais.
   Voir js/engine.js pour l'interprétation générique de ces données.

   KITS : chaque piège n'est pas écrit à la main niveau par niveau, mais
   assemblé par une fonction "kit" paramétrable (position, taille, timing).
   Un kit renvoie un tableau d'objets prêts à être concaténés dans la liste
   `objects` d'un niveau — c'est la "tuile réutilisable" : la même fonction
   Kits.jumpBlocker(...) peut être posée à n'importe quelle coordonnée, dans
   n'importe quel niveau, avec un bouton de désamorçage propre à chaque pose
   (identifiants préfixés pour ne jamais entrer en collision entre deux
   poses du même kit). C'est aussi la structure qu'un LLM générateur de
   niveaux manipulerait : choisir un kit, lui donner des coordonnées.
   ========================================================================= */

const W = 800, H = 450;
const DEFAULT_GRAVITY = 2200;
const MOVE_SPEED = 240, JUMP_VELOCITY = -620, MAX_FALL = 900;
let currentGravity = DEFAULT_GRAVITY;
let walkPhase = 0;
const STEP_UP = 14;

const DESC = {
  FALLING_GENERIC: "Cette plateforme s'effondre peu après que tu marches dessus.",
  FALLING_B: "B s'effondre peu après l'atterrissage, et sa chute déclenche celle de A.",
  FALLING_A: "A s'effondre aussi après l'atterrissage — et encore plus vite si B est déjà tombée.",
  HIDDEN_SPIKE: "Un pic caché se révèle dès que tu poses le pied sur cette zone du sol.",
  FAKE_DOOR: "Cette porte semblait être la sortie... mais le sol se dérobe juste en dessous.",
  BUTTON: "Un bouton qui ouvre une porte verrouillée plus loin.",
  GATE: "Une porte verrouillée qui bloque le passage jusqu'à ce qu'on active le bouton.",
  JUMP_BLOCKER: "Un plafond invisible claque au moment précis où tu sautes ici, et te fait retomber dans le vide.",
  DISABLE_BUTTON: "Un bouton caché, à l'écart du chemin évident, qui désactive un piège plus loin.",
};

/* ---------------------------- Bibliothèque de kits ---------------------------- */
const Kits = {
  /** Sol / plateforme fixe, jamais piégée. */
  static(id, x, y, w, h = 40){
    return [{ id, kind:"static", x, y, w, h, solid:true }];
  },

  /** Bloc flottant purement décoratif (même brique qu'un piège, hors de portée
      normale) : casse l'heuristique "bloc isolé = piège". */
  decoy(id, x, y, w, h = 18){
    return [{ id, kind:"static", x, y, w, h, solid:true }];
  },

  /** Plateforme qui s'effondre `shakeMs` après l'atterrissage. Si `then` est
      fourni ({target, delay, shakeMs}), sa chute déclenche à son tour la
      chute d'une autre plateforme du niveau (chaîne causale). */
  fallingPlatform(id, x, y, w, { h = 22, shakeMs = 400, fallSpeed = 260, description = DESC.FALLING_GENERIC, then = null } = {}){
    const trap = { trigger:{type:"ON_LAND"}, action:{type:"FALL", shakeMs, fallSpeed} };
    if(then) trap.then = [{ target: then.target, delay: then.delay || 0,
      action:{ type:"FALL", shakeMs: then.shakeMs != null ? then.shakeMs : shakeMs, fallSpeed: then.fallSpeed || fallSpeed } }];
    return [{ id, kind:"falling", x, y, w, h, solid:true, description, trap }];
  },

  /** Pic invisible qui se révèle quand le joueur pose le pied dans sa zone. */
  hiddenSpike(id, x, y, w, { h = 22, revealDelay = 150 } = {}){
    return [{ id, kind:"hidden_spike", x, y, w, h, solid:false, hazard:true, visible:false,
      description: DESC.HIDDEN_SPIKE,
      trap:{ trigger:{type:"ON_ENTER"}, action:{type:"REVEAL", delay: revealDelay} } }];
  },

  /** Porte verrouillée (mur) + bouton (sur une petite plate-forme, à côté)
      qui l'ouvre. `prefix` évite toute collision d'identifiants si on pose
      plusieurs portes dans le même niveau. */
  lockedGate(prefix, { gateX, gateY = 290, gateH = 120, padX, padY = 340, padW = 60, padH = 20 }){
    const gateId = prefix+"_gate", padId = prefix+"_pad", btnId = prefix+"_btn";
    return [
      { id: padId, kind:"static", x:padX, y:padY, w:padW, h:padH, solid:true },
      { id: btnId, kind:"button", x:padX, y:padY-18, w:padW, h:16, solid:false, description: DESC.BUTTON,
        trap:{ trigger:{type:"ON_ENTER"}, action:{type:"ACTIVATE"},
               then:[{ target:gateId, delay:0, action:{type:"OPEN"} }] } },
      { id: gateId, kind:"gate", x:gateX, y:gateY, w:16, h:gateH, solid:true, description: DESC.GATE, trap:{} },
    ];
  },

  /** Fausse sortie : une plate-forme "sûre" flottant dans un écart, surmontée
      d'une porte qui ressemble à la sortie. Toucher la porte (geste
      volontaire, jamais nécessaire pour avancer) fait disparaître la porte
      PUIS la plate-forme, `dropDelay` ms plus tard. */
  fakeExit(prefix, { ledgeX, ledgeY, ledgeW, doorX, doorY, doorW, doorH, dropDelay = 150 }){
    const ledgeId = prefix+"_ledge", doorId = prefix+"_door";
    return [
      { id: ledgeId, kind:"falling", x:ledgeX, y:ledgeY, w:ledgeW, h:20, solid:true, description: DESC.FAKE_DOOR, trap:{} },
      { id: doorId, kind:"door", x:doorX, y:doorY, w:doorW, h:doorH, solid:false, description: DESC.FAKE_DOOR,
        trap:{ trigger:{type:"ON_ENTER"}, action:{type:"DISAPPEAR"},
               then:[{ target:ledgeId, delay:dropDelay, action:{type:"FALL", shakeMs:0, fallSpeed:320} }] } },
    ];
  },

  /** LE PLAFOND MENTEUR — la tuile "saut évident au bord d'un trou" :
      sauter depuis la zone `sensor` (généralement le dernier tronçon de sol
      avant le vide) fait instantanément surgir un mur/plafond au-dessus de
      la trajectoire ; il se rétracte tout seul après `appearMs`. Un bouton
      posé À L'ÉCART (jamais sur le chemin direct, toujours accessible par
      un détour) neutralise silencieusement le déclencheur avant même qu'on
      saute — c'est la garantie de solvabilité. Même kit, ré-utilisable à
      n'importe quelle position pour poser d'autres "faux sauts" ailleurs. */
  jumpBlocker(prefix, {
    sensorX, sensorY = 372, sensorW = 50, sensorH = 38,
    blockerX, blockerY = 270, blockerW = 100, blockerH = 60, appearMs = 550,
    padX, padY = 350, padW = 70, padH = 20,
  }){
    const sensorId = prefix+"_sensor", blockerId = prefix+"_blocker";
    const padId = prefix+"_pad", btnId = prefix+"_btn";
    return [
      { id: padId, kind:"static", x:padX, y:padY, w:padW, h:padH, solid:true },
      { id: btnId, kind:"button", x:padX, y:padY-18, w:padW, h:16, solid:false, description: DESC.DISABLE_BUTTON,
        trap:{ trigger:{type:"ON_ENTER"}, action:{type:"ACTIVATE"},
               then:[{ target:sensorId, delay:0, action:{type:"DISABLE"} }] } },
      { id: sensorId, kind:"sensor", x:sensorX, y:sensorY, w:sensorW, h:sensorH, solid:false, visible:false,
        trap:{ trigger:{type:"ON_JUMP"}, action:{type:"NONE"},
               then:[{ target:blockerId, delay:0, action:{type:"APPEAR_TEMP", ms:appearMs} }] } },
      { id: blockerId, kind:"blocker", x:blockerX, y:blockerY, w:blockerW, h:blockerH, solid:false, visible:false,
        description: DESC.JUMP_BLOCKER, trap:{} },
    ];
  },
  /** Murs de bordure : ferme le niveau en haut, à gauche et à droite, pour
      que la seule façon de "sortir" soit de tomber (mort) ou d'atteindre la
      sortie — jamais de quitter l'écran par un bord. Posés en dernier dans
      la liste pour apparaître au premier plan sur les coins. */
  boundaryWalls(thickness = 14){
    return [
      { id:"_boundTop", kind:"gate", x:0, y:0, w:W, h:thickness, solid:true },
      { id:"_boundLeft", kind:"gate", x:0, y:0, w:thickness, h:H, solid:true },
      { id:"_boundRight", kind:"gate", x:W-thickness, y:0, w:thickness, h:H, solid:true },
    ];
  },
};

const LEVELS_SOURCE = [
  {
    id:"l1", name:"Premier saut", difficulty:1, gravity:DEFAULT_GRAVITY,
    playerStart:{x:40,y:372},
    exit:{x:730,y:350,w:40,h:60},
    objects:[
      ...Kits.static("ground1", 0, 410, 260),
      ...Kits.fallingPlatform("B", 320, 410, 90, { shakeMs:450, fallSpeed:260, description:DESC.FALLING_GENERIC }),
      ...Kits.static("ground2", 470, 410, 330),
      ...Kits.decoy("decoy1", 380, 150, 70),
      ...Kits.boundaryWalls(),
    ],
  },
  {
    id:"l2", name:"Effet domino", difficulty:3, gravity:DEFAULT_GRAVITY,
    playerStart:{x:40,y:372},
    exit:{x:730,y:350,w:40,h:60},
    objects:[
      ...Kits.static("ground1", 0, 410, 200),
      ...Kits.fallingPlatform("B", 260, 410, 80, { shakeMs:700, fallSpeed:300, description:DESC.FALLING_B,
        then:{ target:"A", delay:250, shakeMs:500 } }),
      ...Kits.fallingPlatform("A", 400, 410, 80, { shakeMs:700, fallSpeed:300, description:DESC.FALLING_A }),
      ...Kits.static("ground2", 560, 410, 240),
      ...Kits.hiddenSpike("spike1", 582, 388, 26),
      ...Kits.decoy("decoy2", 330, 150, 70),
      ...Kits.boundaryWalls(),
    ],
  },
  {
    id:"l3", name:"Fausse sortie", difficulty:4, gravity:DEFAULT_GRAVITY,
    playerStart:{x:40,y:372},
    exit:{x:730,y:350,w:40,h:60},
    /* Le vrai chemin traverse l'écart (260->350) en un seul saut direct.
       Une plateforme "sûre" flotte dans l'écart pour tenter un joueur prudent :
       si en plus il grimpe jusqu'à la porte au-dessus (geste volontaire, pas
       requis pour avancer), la porte et la plateforme disparaissent et il
       tombe dans le vide. Le chemin direct, lui, ne déclenche jamais le piège. */
    objects:[
      ...Kits.static("groundA", 0, 410, 260),
      ...Kits.fakeExit("fake1", { ledgeX:275, ledgeY:330, ledgeW:70, doorX:290, doorY:150, doorW:40, doorH:70 }),
      ...Kits.static("groundB", 350, 410, 450),
      ...Kits.lockedGate("lock1", { gateX:620, padX:460 }),
      ...Kits.decoy("decoy3", 550, 150, 70),
      ...Kits.boundaryWalls(),
    ],
  },
  {
    id:"l4", name:"Le plafond menteur", difficulty:5, gravity:DEFAULT_GRAVITY,
    playerStart:{x:40,y:372},
    exit:{x:730,y:350,w:40,h:60},
    /* Le saut "évident" au bord de groundA déclenche un plafond qui claque
       au moment exact où le joueur décolle, le renvoyant dans le vide.
       Rien ne le trahit avant : il est invisible et non-solide tant qu'il
       n'a pas été provoqué. La seule garantie de passage est le bouton du
       kit — jamais sur le chemin direct — qui désactive silencieusement
       le déclencheur du plafond avant même qu'on saute. */
    objects:[
      ...Kits.static("groundA", 0, 410, 190),
      ...Kits.jumpBlocker("trap1", {
        padX:90, padY:350, padW:70,
        sensorX:140, sensorW:50,
        blockerX:180, blockerY:270, blockerW:100, blockerH:60, appearMs:550,
      }),
      ...Kits.static("groundB", 310, 410, 490),
      ...Kits.boundaryWalls(),
    ],
  },
];

function clone(o){ return JSON.parse(JSON.stringify(o)); }
function overlap(a,b){ return a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y; }
function approach(cur, target, maxDelta){
  if(cur < target) return Math.min(cur+maxDelta, target);
  if(cur > target) return Math.max(cur-maxDelta, target);
  return cur;
}
/* Détermine de quel(s) côté(s) une boîte (prevBox) qui ne chevauchait pas
   `obj` est entrée en chevauchement dans `obj`. Sert au trigger ON_ENTER
   avec un sens d'entrée requis. */
function enteredFromSides(prevBox, newBox, obj){
  const sides = [];
  if(prevBox.x+prevBox.w <= obj.x && newBox.x+newBox.w > obj.x) sides.push("left");
  if(prevBox.x >= obj.x+obj.w && newBox.x < obj.x+obj.w) sides.push("right");
  if(prevBox.y+prevBox.h <= obj.y && newBox.y+newBox.h > obj.y) sides.push("top");
  if(prevBox.y >= obj.y+obj.h && newBox.y < obj.y+obj.h) sides.push("bottom");
  return sides;
}

const SAVE_KEY = "chutelibre_progress_v1";
function loadProgress(){
  try{
    const raw = localStorage.getItem(SAVE_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  const p = {};
  for(const lv of LEVELS_SOURCE) p[lv.id] = {attempts:0, discovered:[], completed:false};
  return p;
}
function saveProgress(){ try{ localStorage.setItem(SAVE_KEY, JSON.stringify(progress)); }catch(e){} }
let progress = loadProgress();
for(const lv of LEVELS_SOURCE) if(!progress[lv.id]) progress[lv.id] = {attempts:0, discovered:[], completed:false};

/* Niveaux importés manuellement (JSON) en plus des niveaux intégrés — sert
   à vérifier qu'un niveau conçu dans l'éditeur se comporte exactement de
   la même façon une fois chargé ici, dans le vrai jeu. Purement en mémoire
   (pas persisté), pour l'intégration Firebase à venir plus tard. */
let IMPORTED_LEVELS = [];
/* Niveaux chargés automatiquement depuis Firebase au démarrage (ceux dont
   le statut est "FINAL" — les niveaux "PRODUCTION" ne sont jamais proposés
   ici, seulement visibles/testables depuis l'éditeur). */
let FIREBASE_LEVELS = [];
function allLevels(){ return LEVELS_SOURCE.concat(IMPORTED_LEVELS).concat(FIREBASE_LEVELS); }
function ensureLevelProgress(id){
  if(!progress[id]) progress[id] = {attempts:0, discovered:[], completed:false};
}
