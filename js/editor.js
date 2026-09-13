"use strict";
/* =========================================================================
   LEVEL EDITOR — Free Fall
   Data model identical to the one the game consumes (LEVELS_SOURCE):
   a level = { id, name, difficulty, playerStart, exit, objects:[...] }.
   Each object can carry a `trap` { trigger, action, then[] }. The editor
   lets you place, move, resize, configure, and link these
   objects, then export the whole thing as directly-playable JSON.
   "Test" mode reuses the same physics/trigger engine as the game
   (copied from js/engine.js) for an immediate edit/test round-trip.
   ========================================================================= */

const W = 800, H = 450;
const DEFAULT_GRAVITY = 3000;
const DEFAULT_MOVE_SPEED = 240;
const JUMP_VELOCITY = -620, MAX_FALL = 900, STEP_UP = 14;
let currentMoveSpeed = DEFAULT_MOVE_SPEED;
let controlsInverted = false;
let currentGravity = DEFAULT_GRAVITY;
const GRID = 20;

/* ---------------------------- Object library (palette) ----------------------------
   Deliberately reduced to a small, generic, composable base: everything
   else (falling platform, door, locked gate, popping ceiling, decor)
   is rebuilt from "Floor / platform" + trigger/action/link
   — this is more flexible than a fixed catalog of specialized blocks, and
   it's the game's "kit" logic. Older JSON exports containing these kinds
   (falling, door, gate, blocker, decoy) still display correctly if
   re-imported: only the generic rendering is kept, only the palette is
   reduced. */
const KIND_LIB = [
  { kind:"static", label:"Floor / platform / wall", color:"#a1382a", w:120, h:40,
    defaults:{ solid:true, trap:{ trigger:{type:"ON_ENTER"}, action:{type:"NONE"} } } },
  { kind:"hidden_spike", label:"Hidden spike", color:"#e0455c", w:20, h:20,
    defaults:{ solid:false, hazard:true, visible:false, description:"A hidden spike reveals itself when approached.",
      trap:{ trigger:{type:"ON_ENTER"}, action:{type:"REVEAL", delay:150} } } },
  { kind:"button", label:"Button", color:"#8a6a3a", w:60, h:20,
    defaults:{ solid:false, description:"A button that triggers something elsewhere.",
      trap:{ trigger:{type:"ON_ENTER"}, action:{type:"ACTIVATE"} } } },
  { kind:"sensor", label:"Trigger (invisible zone)", color:"#3d5af1", w:40, h:40,
    defaults:{ solid:false, visible:false,
      trap:{ trigger:{type:"ON_ENTER"}, action:{type:"NONE"} } } },
];
function kindMeta(kind){ return KIND_LIB.find(k=>k.kind===kind) || KIND_LIB[0]; }

const TRIGGER_TYPES = [
  { type:"NONE", label:"None" },
  { type:"ON_LAND", label:"On landing (ON_LAND)" },
  { type:"ON_ENTER", label:"On entering the zone (ON_ENTER)" },
  { type:"ON_JUMP", label:"On jumping (ON_JUMP)" },
  { type:"ON_TIMER", label:"After a delay from the start (ON_TIMER)" },
  { type:"ON_ATTEMPT", label:"From the Nth attempt onward (ON_ATTEMPT)" },
];
const ACTION_TYPES = [
  { type:"NONE", label:"None" },
  { type:"FALL", label:"Shake then fall (FALL)" },
  { type:"DISAPPEAR", label:"Disappear (DISAPPEAR)" },
  { type:"REVEAL", label:"Reveal itself (REVEAL)" },
  { type:"OPEN", label:"Open / become passable (OPEN)" },
  { type:"ACTIVATE", label:"Activate (cosmetic) (ACTIVATE)" },
  { type:"APPEAR_TEMP", label:"Pop up then retract (APPEAR_TEMP)" },
  { type:"DISABLE", label:"Silently disable the target (DISABLE)" },
  { type:"MOVE", label:"Move at constant speed (MOVE)" },
  { type:"MOVE_TO", label:"Move to a fixed position (MOVE_TO)" },
  { type:"ROTATE", label:"Continuous rotation (ROTATE)" },
];
/* Actions available on the special SCENE target (global level
   parameters) and the special PLAYER target (the character itself). */
const SCENE_ACTION_TYPES = [
  { type:"NONE", label:"None" },
  { type:"SET_GRAVITY", label:"Change gravity (SET_GRAVITY)" },
  { type:"SET_SPEED", label:"Change player speed (SET_SPEED)" },
  { type:"SET_CONTROLS", label:"Invert controls (SET_CONTROLS)" },
];
const PLAYER_ACTION_TYPES = [
  { type:"NONE", label:"None" },
  { type:"MOVE", label:"Movement impulse (MOVE)" },
  { type:"CHANGE_WIDTH", label:"Change width (CHANGE_WIDTH)" },
  { type:"CHANGE_HEIGHT", label:"Change height (CHANGE_HEIGHT)" },
];
function actionTypesForTarget(target){
  if(target==="SCENE") return SCENE_ACTION_TYPES;
  if(target==="PLAYER") return PLAYER_ACTION_TYPES;
  return ACTION_TYPES;
}

/* ---------------------------- Document model ---------------------------- */
/* Random identifier drawn when a level is created — used as the Firebase
   key and as the sort order in the game's "snake" map (levels are sorted
   by this identifier, not by their name). Purely numeric: always a
   valid Realtime Database key. */
function randomLevelId(){
  return String(Math.floor(100000000 + Math.random()*900000000));
}
function makeEmptyLevel(id, name){
  return {
    id: id || randomLevelId(), name, difficulty:1, gravity:DEFAULT_GRAVITY, playerStart:{x:40,y:372}, exit:{x:720,y:380,w:40,h:40},
    /* Closed off at the top/left/right by default: the only way to "leave"
       is by falling (death) or reaching the exit — never through a
       screen edge. These are objects like any other: movable/deletable if
       the level needs that instead. */
    objects:[
      { id:"_boundTop", kind:"gate", x:0,y:0,w:800,h:20, solid:true },
      { id:"_boundLeft", kind:"gate", x:0,y:0,w:20,h:450, solid:true },
      { id:"_boundRight", kind:"gate", x:780,y:0,w:20,h:450, solid:true },
    ],
  };
}
let level = makeEmptyLevel(null, "Level 1");
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
/* Boundary walls (_boundTop/_boundLeft/_boundRight) are placed by
   default on every level and must never be deletable — like the
   exit and the starting point, they're structural landmarks. */
function isLocked(id){ return typeof id === "string" && id.indexOf("_bound") === 0; }
function snap(v){ return gridOn ? Math.round(v/GRID)*GRID : Math.round(v); }

/* ---------------------------- View (zoom / pan) ---------------------------- */
/* The canvas no longer draws into a fixed 800x450 frame: it fills all of
   #canvasWrap, and a transform (zoom + offset) places the "world"
   (still 800x450 in level coordinates) inside it. All mouse coordinates
   go through canvasPoint(), which already applies the inverse of this
   transform — the rest of the code (selection, drag, placement) keeps
   reasoning in world coordinates without knowing anything about zoom. */
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

/* ---------------------------- Rendering (reuses the game's brick style) ---------------------------- */
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
    case "static": case "decoy": drawBlockTile(o.x,o.y,o.w,o.h); break;
    case "falling":
      drawBlockTile(o.x,o.y,o.w,o.h);
      ctx.strokeStyle="rgba(40,20,10,.5)"; ctx.lineWidth=1.5;
      ctx.beginPath(); ctx.moveTo(o.x+o.w*0.32,o.y+2); ctx.lineTo(o.x+o.w*0.45,o.y+o.h*0.6); ctx.lineTo(o.x+o.w*0.38,o.y+o.h-2); ctx.stroke();
      break;
    case "gate": drawBlockTile(o.x,o.y,o.w,o.h); break;
    case "blocker":
      drawBlockTile(o.x,o.y,o.w,o.h);
      ctx.strokeStyle="rgba(224,69,92,.6)"; ctx.lineWidth=2; ctx.strokeRect(o.x+1,o.y+1,o.w-2,o.h-2);
      break;
    case "hidden_spike":
      drawPlantRow(o.x,o.y,o.w,o.h);
      break;
    case "door":
      drawDoorShape(o.x,o.y,o.w,o.h, "#3d5af1", "#eef0ff", "#1f2d8a");
      break;
    case "button":
      if(BUMP_SPRITES[0].complete && BUMP_SPRITES[0].naturalWidth){
        const img = BUMP_SPRITES[0];
        ctx.imageSmoothingEnabled = false;
        const scale = GRID/img.naturalWidth, dw=GRID, dh=img.naturalHeight*scale;
        const n = Math.max(1, Math.round(o.w/GRID));
        for(let i=0;i<n;i++){
          const cx = o.x + i*GRID + GRID/2;
          ctx.drawImage(img, cx-dw/2, o.y+o.h-dh, dw, dh);
        }
      } else {
        drawStoneBrick(o.x,o.y,o.w,o.h);
        { const cx=o.x+o.w/2, cy=o.y+o.h/2, r=Math.min(o.w,o.h)*0.28;
          ctx.fillStyle = o.state==="activated" ? "#4f8f6a" : "#8a6a3a";
          ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill(); }
      }
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

  // id label
  ctx.fillStyle="rgba(20,22,36,.65)"; ctx.font=(10/view.zoom)+"px monospace"; ctx.textAlign="left";
  ctx.fillText(o.id, o.x+3, o.y-3 < 8 ? o.y+12 : o.y-3);

  if(isSelected){
    ctx.strokeStyle="#3d5af1"; ctx.lineWidth=2/view.zoom; ctx.strokeRect(o.x-2,o.y-2,o.w+4,o.h+4);
    // resize handle (bottom-right corner) — constant on-screen size
    const hs = 12/view.zoom;
    ctx.fillStyle="#3d5af1"; ctx.fillRect(o.x+o.w-hs/2,o.y+o.h-hs/2,hs,hs);
  }
}

/* Door: a rounded frame + an inner panel + a bar + a
   handle, rather than a plain blue rectangle. Shared by edit mode
   and test mode, and by the exit and "door" objects. */
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

/* Mario block tiling (block.png, 16x16 native), scaled to
   the level's grid (GRID) — same logic as the real game's rendering
   (render.js), duplicated here for edit mode AND test mode, which have
   chacun leur propre contexte canvas (`ctx`, pas `ctx2d`). Tant que
   their own canvas context. While the image isn't loaded, falls back to the old vector pattern. */
function drawBlockTile(x,y,w,h){
  ctx.save();
  ctx.beginPath(); ctx.rect(x,y,w,h); ctx.clip();
  if(SPRITE_BLOCK.complete && SPRITE_BLOCK.naturalWidth>0){
    ctx.imageSmoothingEnabled = false;
    const startX = Math.floor(x/GRID)*GRID;
    const startY = Math.floor(y/GRID)*GRID;
    for(let ty=startY; ty<y+h; ty+=GRID){
      for(let tx=startX; tx<x+w; tx+=GRID){
        ctx.drawImage(SPRITE_BLOCK, tx, ty, GRID, GRID);
      }
    }
  } else {
    drawBrick(x,y,w,h);
  }
  ctx.restore();
}

/* Piranha plant: one image per grid unit of width (GRID), all
   animated AT THE SAME TIME (shared clock, no per-object phase) — changes
   frame every second. Duplicated from the game (render.js): a different canvas context
   distinct (`ctx`), horloge de mode test (`playNow`) au lieu de `now`. En
   (`ctx`). In edit mode (no game running), Date.now() is used instead. */
function plantFrameIndex(){
  const t = (typeof playRunning!=="undefined" && playRunning) ? playNow : Date.now();
  return Math.floor(t/1000) % PLANT_SPRITES.length;
}
function drawPlantRow(x,y,w,h){
  const img = PLANT_SPRITES[plantFrameIndex()];
  const n = Math.max(1, Math.round(w/GRID));
  if(!img || !img.complete || !img.naturalWidth){
    ctx.fillStyle = "#e0455c";
    const cw = w/n;
    for(let i=0;i<n;i++){
      const sx = x + i*cw;
      ctx.beginPath();
      ctx.moveTo(sx, y+h); ctx.lineTo(sx+cw/2, y); ctx.lineTo(sx+cw, y+h);
      ctx.closePath(); ctx.fill();
    }
    return;
  }
  ctx.imageSmoothingEnabled = false;
  const scale = GRID/img.naturalWidth;
  const dw = GRID, dh = img.naturalHeight*scale;
  for(let i=0;i<n;i++){
    const cx = x + i*GRID + GRID/2;
    ctx.drawImage(img, cx-dw/2, y+h-dh, dw, dh);
  }
}

/* Exit (pipe), with a fallback to the old door while the image hasn't
   loaded. */
function drawExitSprite(x,y,w,h,curPlayMode){
  if(SPRITE_TUBE.complete && SPRITE_TUBE.naturalWidth>0){
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(SPRITE_TUBE, x, y, w, h);
    ctx.restore();
  } else {
    drawDoorShape(x,y,w,h, curPlayMode==="won"?"#2fb380":"#3a9c6c", "#eafff3", "#164a33");
  }
}

/* Test-mode clouds — same logic as the game (render.js): 2-3 clouds
   among 3 sizes, uniform slow drift, reset on each test
   run. No clouds in edit mode (a working canvas, no animated
   preview so as not to distract). */
let clouds = [];
let cloudDriftDir = 1;
function initClouds(){
  const count = 2 + Math.floor(Math.random()*2);
  cloudDriftDir = Math.random()<0.5 ? -1 : 1;
  clouds = [];
  for(let i=0;i<count;i++){
    clouds.push({ spriteIdx: Math.floor(Math.random()*CLOUD_SPRITES.length), x: Math.random()*W, y: 14+Math.random()*70 });
  }
}
const CLOUD_SPEED = 6;
function updatePlayClouds(dt){
  for(const c of clouds){
    c.x += cloudDriftDir*CLOUD_SPEED*dt;
    if(c.x>W+90) c.x=-90;
    if(c.x<-90) c.x=W+90;
  }
}
function drawClouds(){
  for(const c of clouds){
    const img = CLOUD_SPRITES[c.spriteIdx];
    if(!img || !img.complete || !img.naturalWidth) continue;
    ctx.drawImage(img, c.x, c.y, img.naturalWidth, img.naturalHeight);
  }
}

/* Test-mode button (bump.png, 3 frames) — same logic as the game
   (render.js), duplicated here (separate `ctx` canvas context). One frame
   per grid unit of width, all sharing the same pressPhase. */
function buttonFrameForPhase(phase){
  return phase<0.34 ? BUMP_SPRITES[0] : (phase<0.67 ? BUMP_SPRITES[1] : BUMP_SPRITES[2]);
}
function drawButtonSpriteEd(o){
  const phase = o.pressPhase || 0;
  const img = buttonFrameForPhase(phase);
  const n = Math.max(1, Math.round(o.w/GRID));
  if(!img || !img.complete || !img.naturalWidth){
    const cw = o.w/n;
    for(let i=0;i<n;i++){
      const sx = o.x+i*cw;
      drawStoneBrick(sx,o.y,cw,o.h);
      const cx=sx+cw/2, cy=o.y+o.h/2, r=Math.min(cw,o.h)*0.28;
      ctx.fillStyle = phase>0.5 ? "#4f8f6a" : "#8a6a3a";
      ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill();
    }
    return;
  }
  ctx.imageSmoothingEnabled = false;
  const scale = GRID/img.naturalWidth, dw=GRID, dh=img.naturalHeight*scale;
  for(let i=0;i<n;i++){
    const cx = o.x + i*GRID + GRID/2;
    ctx.drawImage(img, cx-dw/2, o.y+o.h-dh, dw, dh);
  }
}
/* Visual sink, computed from the actual sprite geometry (same as the
   game's render.js) rather than a guessed constant. */
function playerButtonSinkOffset(){
  const img0 = BUMP_SPRITES[0];
  if(!img0.complete || !img0.naturalWidth) return 0;
  const scale = GRID/img0.naturalWidth;
  const dh0 = img0.naturalHeight*scale;
  let maxSink = 0;
  for(const o of playObjects){
    if(o.kind!=="button" || !(o.pressPhase>0) || !playOverlap(P,o)) continue;
    const imgCur = buttonFrameForPhase(o.pressPhase);
    if(!imgCur.complete || !imgCur.naturalWidth) continue;
    const dhCur = imgCur.naturalHeight*scale;
    const sink = dh0 - dhCur;
    if(sink>maxSink) maxSink = sink;
  }
  return maxSink;
}

/* Player death explosion (same logic as the game, render.js). */
let particles = [];
function spawnDeathExplosion(x,y){
  particles = [];
  const colors = ["#e0455c","#8a5a2a","#f0a868","#fff3c4"];
  for(let i=0;i<14;i++){
    const angle = Math.random()*Math.PI*2;
    const speed = 90+Math.random()*170;
    particles.push({ x, y, vx:Math.cos(angle)*speed, vy:Math.sin(angle)*speed-120, size:3+Math.random()*4, color:colors[Math.floor(Math.random()*colors.length)], life:1 });
  }
}
function updateParticles(dt){
  if(!particles.length) return;
  for(const p of particles){ p.vy += 1300*dt; p.x += p.vx*dt; p.y += p.vy*dt; p.life -= dt*0.55; }
  particles = particles.filter(p => p.life>0 && p.y<H+60);
}
function drawParticles(){
  for(const p of particles){
    ctx.save(); ctx.globalAlpha = Math.max(0,Math.min(1,p.life)); ctx.fillStyle = p.color;
    ctx.fillRect(p.x-p.size/2, p.y-p.size/2, p.size, p.size);
    ctx.restore();
  }
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
    ctx.fillText(linkSourceId ? "Click the link's target…" : "Click the link's source object…", W/2, 20);
  }
  ctx.restore();
}

/* ---------------------------- Interaction souris/tactile ---------------------------- */
let drag = null; // {type:'move'|'resize', id, offsetX, offsetY, startW, startH}

function canvasPoint(evt){
  const rect = canvas.getBoundingClientRect();
  const cx = (evt.touches ? evt.touches[0].clientX : evt.clientX) - rect.left;
  const cy = (evt.touches ? evt.touches[0].clientY : evt.clientY) - rect.top;
  // screen -> canvas pixels (the canvas can be displayed at a CSS size
  // different from its internal resolution) -> world (by inverting zoom/pan).
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
    /* Le bouton a une hauteur fixe (calée sur la taille naturelle du
       sprite bump.png) : sa hauteur ne se redimensionne jamais depuis la
       poignée, seule sa largeur (le nombre de cases) change. */
    o.h = o.kind==="button" ? GRID : Math.max(GRID, snap(drag.startH + (pt.y-drag.startY)));
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

/* The properties panel is independent of selection: clicking an
   object on the stage selects it (blue outline, duplicate/
   delete buttons enabled) and refreshes the panel's CONTENT, but doesn't
   open it. Only the ⚙️ icon (or placing a new object) opens it; the ✕
   button and a click outside close it — without losing the selection. */
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
/* Click outside the panel (and outside the canvas, which already handles its
   own selection): closes the panel if it was open. */
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
  const idField = el("div",{class:"field"}, el("label",{text:"Level identifier"}),
    el("input",{type:"text", value:lvl.id, oninput:(e)=>{ lvl.id=e.target.value; }}));
  const nameField = el("div",{class:"field"}, el("label",{text:"Nom"}),
    el("input",{type:"text", value:lvl.name, oninput:(e)=>{ lvl.name=e.target.value; }}));
  const diffField = el("div",{class:"field"}, el("label",{text:"Difficulty (1-5)"}),
    el("input",{type:"number", min:"1", max:"5", value:lvl.difficulty, oninput:(e)=>{ lvl.difficulty=Math.max(1,Math.min(5,parseInt(e.target.value)||1)); }}));
  const gravField = numField("Gravity (px/s², default "+DEFAULT_GRAVITY+")", lvl.gravity!=null?lvl.gravity:DEFAULT_GRAVITY, v=>{ lvl.gravity=v; });
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
/* Special cascade targets, in addition to level objects: SCENE (to
   change a global parameter like gravity) and PLAYER (to act
   directly on the character: size, movement impulse). */
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
    container.appendChild(numField("Delay before reveal (ms)", action.delay!=null?action.delay:150, v=>{ action.delay=v; onchange(); }));
  } else if(action.type==="APPEAR_TEMP"){
    container.appendChild(numField("Duration before retracting (ms)", action.ms!=null?action.ms:500, v=>{ action.ms=v; onchange(); }));
  } else if(action.type==="MOVE"){
    container.appendChild(selectField("Direction", [
      {type:"left",label:"Gauche"},{type:"right",label:"Droite"},{type:"up",label:"Haut"},{type:"down",label:"Bas"}
    ], action.direction||"right", v=>{ action.direction=v; onchange(); }));
    container.appendChild(numField("Vitesse maximale (px/s)", action.speed!=null?action.speed:100, v=>{ action.speed=v; onchange(); }));
    container.appendChild(numField("Acceleration (px/s², 0 = instant)", action.acceleration!=null?action.acceleration:0, v=>{ action.acceleration=v; onchange(); }));
    container.appendChild(numField("Movement duration (ms, 0 = indefinite)", action.duration!=null?action.duration:1000, v=>{ action.duration=v; onchange(); }));
  } else if(action.type==="MOVE_TO"){
    container.appendChild(numField("Position X cible (px)", action.x!=null?action.x:0, v=>{ action.x=v; onchange(); }));
    container.appendChild(numField("Position Y cible (px)", action.y!=null?action.y:0, v=>{ action.y=v; onchange(); }));
    container.appendChild(numField("Vitesse (px/s)", action.speed!=null?action.speed:100, v=>{ action.speed=v; onchange(); }));
    container.appendChild(numField("Acceleration (px/s², 0 = instant)", action.acceleration!=null?action.acceleration:0, v=>{ action.acceleration=v; onchange(); }));
  } else if(action.type==="ROTATE"){
    container.appendChild(selectField("Sens", [{type:"cw",label:"Horaire"},{type:"ccw",label:"Antihoraire"}], action.direction||"cw", v=>{ action.direction=v; onchange(); }));
    container.appendChild(numField("Speed (degrees/s)", action.speed!=null?action.speed:90, v=>{ action.speed=v; onchange(); }));
    container.appendChild(numField("Duration (ms, 0 = indefinite)", action.duration!=null?action.duration:0, v=>{ action.duration=v; onchange(); }));
  } else if(action.type==="SET_GRAVITY"){
    container.appendChild(numField("New gravity (px/s²)", action.value!=null?action.value:DEFAULT_GRAVITY, v=>{ action.value=v; onchange(); }));
  } else if(action.type==="SET_SPEED"){
    container.appendChild(numField("New movement speed (px/s)", action.value!=null?action.value:DEFAULT_MOVE_SPEED, v=>{ action.value=v; onchange(); }));
  } else if(action.type==="SET_CONTROLS"){
    container.appendChild(selectField("Controls", [{type:"standard",label:"Standard"},{type:"inverted",label:"Inverted"}], action.value||"standard", v=>{ action.value=v; onchange(); }));
  } else if(action.type==="CHANGE_WIDTH"){
    container.appendChild(numField("New player width (px)", action.value!=null?action.value:26, v=>{ action.value=v; onchange(); }));
  } else if(action.type==="CHANGE_HEIGHT"){
    container.appendChild(numField("New player height (px)", action.value!=null?action.value:38, v=>{ action.value=v; onchange(); }));
  }
}

function renderInspector(){
  inspectorBody.innerHTML = "";
  const lvl = curLevel();

  if(selectedId==="__exit__"){
    btnDuplicate.disabled = true; btnDelete.disabled = true;
    const e = lvl.exit;
    inspectorBody.appendChild(el("p",{}, document.createTextNode("Level exit")));
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
    inspectorBody.appendChild(el("p",{}, document.createTextNode("Player starting point")));
    const row = el("div",{class:"row2"});
    row.appendChild(numField("x", p.x, v=>{ p.x=v; render(); }));
    row.appendChild(numField("y", p.y, v=>{ p.y=v; render(); }));
    inspectorBody.appendChild(row);
    return;
  }

  const o = selectedObj();
  if(!o){
    btnDuplicate.disabled = true; btnDelete.disabled = true;
    inspectorBody.innerHTML = '<p class="empty">Nothing selected. Click an object on the stage, or pick an item from the library to place a new one.</p>';
    return;
  }
  btnDuplicate.disabled = false; btnDelete.disabled = isLocked(o.id);
  if(isLocked(o.id)){
    inspectorBody.appendChild(el("p",{class:"empty", text:"Default boundary wall — cannot be deleted."}));
  }

  inspectorBody.appendChild(el("div",{class:"field"},
    el("label",{text:"Identifiant"}),
    el("input",{type:"text", value:o.id, oninput:(e)=>{
      const v = e.target.value.trim();
      const dup = curLevel().objects.some(other=>other!==o && other.id===v);
      warnEl.textContent = (!v || dup) ? "Empty or already-used identifier." : "";
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

  inspectorBody.appendChild(selectField("Object type (kind)", KIND_LIB.map(k=>({type:k.kind,label:k.label})), o.kind, v=>{ o.kind=v; render(); }));

  inspectorBody.appendChild(checkField("Solid (blocks the player)", o.solid, v=>{ o.solid=v; }));
  inspectorBody.appendChild(checkField("Dangereux au contact (hazard)", o.hazard, v=>{ o.hazard=v; }));
  inspectorBody.appendChild(checkField("Visible at start", o.visible!==false, v=>{ o.visible=v; render(); }));
  inspectorBody.appendChild(checkField("Solid even hidden (otherwise: invisible = non-solid, until revealed)", o.solidWhenHidden, v=>{ o.solidWhenHidden=v; }));

  if(o.kind==="hidden_spike"){
    inspectorBody.appendChild(selectField("Spike direction", [
      {type:"0", label:"Up"},
      {type:"90", label:"Right"},
      {type:"180", label:"Down"},
      {type:"270", label:"Left"},
    ], String(o.angle||0), v=>{ o.angle = parseInt(v,10); render(); }));
  }

  inspectorBody.appendChild(textareaField("Description (shown if the player dies because of this object)", o.description, v=>{ o.description=v; }));

  // ---- Trigger ----
  if(!o.trap) o.trap = {};
  const trigBox = el("div",{class:"sectionBox"});
  trigBox.appendChild(el("div",{class:"sectionTitle", text:"Trigger"}));
  const trigType = o.trap.trigger ? o.trap.trigger.type : "NONE";
  trigBox.appendChild(selectField("Type", TRIGGER_TYPES, trigType, v=>{
    if(v==="NONE"){ delete o.trap.trigger; } else { o.trap.trigger = Object.assign({type:v}, o.trap.trigger&&o.trap.trigger.type===v?o.trap.trigger:{}); }
    renderInspector();
  }));
  if(o.trap.trigger){
    if(o.trap.trigger.type==="ON_TIMER"){
      trigBox.appendChild(numField("Delay from level start (ms)", o.trap.trigger.delay||0, v=>{ o.trap.trigger.delay=v; }));
    } else if(o.trap.trigger.type==="ON_ATTEMPT"){
      trigBox.appendChild(numField("Nombre de tentatives minimum", o.trap.trigger.count||1, v=>{ o.trap.trigger.count=v; }));
    } else if(o.trap.trigger.type==="ON_ENTER"){
      trigBox.appendChild(selectField("Required entry direction", [
        {type:"any",label:"Any"},{type:"left",label:"From the left"},{type:"right",label:"From the right"},
        {type:"top",label:"From the top"},{type:"bottom",label:"From the bottom"},
      ], o.trap.trigger.fromSide||"any", v=>{ o.trap.trigger.fromSide = v==="any" ? undefined : v; }));
    }
  }
  inspectorBody.appendChild(trigBox);

  // ---- Action ----
  const actBox = el("div",{class:"sectionBox"});
  actBox.appendChild(el("div",{class:"sectionTitle", text:"Action (on this object)"}));
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
  casBox.appendChild(el("div",{class:"sectionTitle", text:"Cascade (triggers other objects, the scene, or the player)"}));
  const others = allCascadeTargets(o.id);
  if(!o.trap.then) o.trap.then = [];
  if(!o.trap.then.length){
    casBox.appendChild(el("p",{class:"empty", text:"No links. Use \"Link →\" below (objects only) or add an entry in the list (objects, SCENE, PLAYER)."}));
  }
  o.trap.then.forEach((link, idx)=>{
    const row = el("div",{class:"thenRow"});
    const top = el("div",{class:"rowTop"},
      el("span",{class:"idTag", text:"→ "+link.target}),
      el("button",{class:"miniBtn", text:"✕", onclick:()=>{ o.trap.then.splice(idx,1); renderInspector(); render(); }})
    );
    row.appendChild(top);
    row.appendChild(selectField("Cible", others.map(id=>({type:id,label:id})), link.target, v=>{ link.target=v; link.action={type:"NONE"}; renderInspector(); render(); }));
    row.appendChild(numField("Delay (ms)", link.delay||0, v=>{ link.delay=v; }));
    if(!link.action) link.action = {type:"NONE"};
    row.appendChild(selectField("Action on the target", actionTypesForTarget(link.target), link.action.type, v=>{ link.action={type:v}; renderInspector(); }));
    const paramsWrap = el("div",{});
    row.appendChild(paramsWrap);
    renderActionParams(paramsWrap, link.action, ()=>{});
    casBox.appendChild(row);
  });
  const addBtn = el("button",{class:"addBtn", text:"+ Add a cascade (list)", onclick:()=>{
    if(!others.length) return;
    o.trap.then.push({ target:others[0], delay:200, action:{type:"NONE"} });
    renderInspector();
  }});
  casBox.appendChild(addBtn);
  const linkBtn = el("button",{class:"addBtn", text: (mode==="link"&&linkSourceId===o.id) ? "Cancel link…" : "🔗 Link → (click the target on the stage)", onclick:()=>{
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

/* ---------------------------- Import / Export JSON (single level) ---------------------------- */
document.getElementById("btnExport").addEventListener("click", ()=>{
  const blob = new Blob([JSON.stringify(level, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeName = (level.id || "level").replace(/[^a-z0-9_-]+/gi, "-");
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
      /* Accepts a single level (the current format), or for convenience an
         older multi-level export ({levels:[...]} or an array), from which
         only the first level is used. */
      let imported;
      if(Array.isArray(parsed)) imported = parsed[0];
      else if(parsed.levels) imported = parsed.levels[0];
      else imported = parsed;
      if(!imported || !imported.objects) throw new Error("unexpected level format");
      level = Object.assign(makeEmptyLevel(imported.id||null, imported.name||"Level"), imported);
      selectedId = null; mode="select"; placeKind=null; linkSourceId=null;
      renderLevelMeta(); renderInspector(); refreshPaletteActive(); fitView(); render();
    }catch(err){ alert("Fichier JSON invalide : "+err.message); }
  };
  reader.readAsText(file);
  e.target.value = "";
});
document.getElementById("btnResetLevel").addEventListener("click", () => {
  if(!confirm("Reset everything? The current level will be lost (export it first if needed).")) return;
  level = makeEmptyLevel(null, "Level 1");
  selectedId = null; mode="select"; placeKind=null; linkSourceId=null;
  setInspectorOpen(false);
  renderLevelMeta(); renderInspector(); refreshPaletteActive(); fitView(); render();
});

/* ---------------------------- Firebase window ---------------------------- */
const fbBackdrop = document.getElementById("fbBackdrop");
const fbModal = document.getElementById("fbModal");
function openFirebaseModal(){
  fbBackdrop.classList.add("show"); fbModal.classList.add("show");
  setFirebaseTab("loadsave");
  refreshFirebaseLevelList();
}
function closeFirebaseModal(){ fbBackdrop.classList.remove("show"); fbModal.classList.remove("show"); }
document.getElementById("btnFirebase").addEventListener("click", openFirebaseModal);
document.getElementById("fbModalClose").addEventListener("click", closeFirebaseModal);
fbBackdrop.addEventListener("click", closeFirebaseModal);

function setFirebaseTab(tab){
  const isLoad = tab==="loadsave";
  document.getElementById("fbTabLoadSave").classList.toggle("active", isLoad);
  document.getElementById("fbTabManage").classList.toggle("active", !isLoad);
  document.getElementById("fbPanelLoadSave").style.display = isLoad ? "" : "none";
  document.getElementById("fbPanelManage").style.display = isLoad ? "none" : "";
  if(!isLoad) refreshFirebaseManageList();
}
document.getElementById("fbTabLoadSave").addEventListener("click", ()=>setFirebaseTab("loadsave"));
document.getElementById("fbTabManage").addEventListener("click", ()=>setFirebaseTab("manage"));

document.getElementById("fbSaveBtn").addEventListener("click", async ()=>{
  const status = document.getElementById("fbStatusSelect").value;
  const msg = document.getElementById("fbSaveStatus");
  msg.textContent = "Sauvegarde en cours…"; msg.className = "fbStatusMsg";
  try{
    await firebaseSaveLevel(level, status);
    msg.textContent = "Level \""+level.name+"\" saved ("+status+")."; msg.className = "fbStatusMsg ok";
    refreshFirebaseLevelList();
  }catch(err){
    msg.textContent = "Failed: " + err.message; msg.className = "fbStatusMsg error";
  }
});

document.getElementById("fbRefreshBtn").addEventListener("click", refreshFirebaseLevelList);

async function refreshFirebaseLevelList(){
  const listEl = document.getElementById("fbLevelList");
  listEl.innerHTML = '<p class="empty">Loading…</p>';
  try{
    const levels = await firebaseListLevels();
    const ids = Object.keys(levels);
    if(!ids.length){ listEl.innerHTML = '<p class="empty">No levels on Firebase yet.</p>'; return; }
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
        '<button class="tbtn" data-load-id="'+id+'">Load</button>'+
        '</div>';
      row.querySelector("[data-load-id]").addEventListener("click", async ()=>{
        try{
          const loaded = await firebaseLoadLevel(id);
          level = Object.assign(makeEmptyLevel(loaded.id||id, loaded.name||"Level"), loaded);
          selectedId = null; mode="select"; placeKind=null; linkSourceId=null;
          renderLevelMeta(); renderInspector(); refreshPaletteActive(); fitView(); render();
          closeFirebaseModal();
        }catch(err){ alert("Load failed: " + err.message); }
      });
      listEl.appendChild(row);
    }
  }catch(err){
    listEl.innerHTML = '<p class="empty">Error: '+err.message+'</p>';
  }
}

/* "Organize" tab: editable list (order / name), with deletion.
   Each row loads the full level once (so it can be
   re-save it intact with just order/name changed) and only writes to
   Firebase when you click "Save" on THAT row. */
async function refreshFirebaseManageList(){
  const listEl = document.getElementById("fbManageList");
  const statusEl = document.getElementById("fbManageStatus");
  statusEl.textContent = "";
  listEl.innerHTML = '<p class="empty">Loading…</p>';
  try{
    const levels = await firebaseListLevels();
    const ids = Object.keys(levels);
    if(!ids.length){ listEl.innerHTML = '<p class="empty">No levels on Firebase yet.</p>'; return; }
    // Sort by existing order (falling back to id) so the list already reflects the current ranking.
    ids.sort((a,b)=>{
      const oa = levels[a].order, ob = levels[b].order;
      if(oa!=null && ob!=null) return oa-ob;
      if(oa!=null) return -1;
      if(ob!=null) return 1;
      return (parseInt(a,10)||0)-(parseInt(b,10)||0);
    });
    listEl.innerHTML = "";
    for(const id of ids){
      const lv = levels[id];
      const status = lv.status==="FINAL" ? "FINAL" : "PRODUCTION";
      const row = document.createElement("div");
      row.className = "fbManageRow";
      row.innerHTML =
        '<div class="fbManageTop">'+
          '<input type="number" class="fbOrderInput" value="'+(lv.order!=null?lv.order:"")+'" placeholder="#" title="Ordre d\'affichage">'+
          '<input type="text" class="fbNameInput" value="'+(lv.name||"").replace(/"/g,"&quot;")+'">'+
          '<span class="fbBadge '+status+'">'+status+'</span>'+
        '</div>'+
        '<div class="fbManageId">'+id+'</div>'+
        '<div class="fbManageActions">'+
          '<button class="tbtn primary" data-save="'+id+'">Enregistrer</button>'+
          '<button class="tbtn danger" data-delete="'+id+'">Supprimer</button>'+
        '</div>';
      row.querySelector("[data-save]").addEventListener("click", async (e)=>{
        const orderVal = row.querySelector(".fbOrderInput").value;
        const nameVal = row.querySelector(".fbNameInput").value.trim();
        const updated = Object.assign({}, lv, {
          name: nameVal || lv.name,
          order: orderVal==="" ? undefined : Number(orderVal),
        });
        e.target.textContent = "…";
        try{
          await firebaseSaveLevel(updated, lv.status||"PRODUCTION");
          statusEl.textContent = "\""+updated.name+"\" updated."; statusEl.className = "fbStatusMsg ok";
        }catch(err){
          statusEl.textContent = "Failed: "+err.message; statusEl.className = "fbStatusMsg error";
        }
        e.target.textContent = "Enregistrer";
      });
      row.querySelector("[data-delete]").addEventListener("click", async ()=>{
        if(!confirm("Permanently delete level \""+(lv.name||id)+"\" from Firebase?")) return;
        try{
          await firebaseDeleteLevel(id);
          row.remove();
          statusEl.textContent = "Level deleted."; statusEl.className = "fbStatusMsg ok";
        }catch(err){
          statusEl.textContent = "Delete failed: "+err.message; statusEl.className = "fbStatusMsg error";
        }
      });
      listEl.appendChild(row);
    }
  }catch(err){
    listEl.innerHTML = '<p class="empty">Error: '+err.message+'</p>';
  }
}
document.getElementById("fbManageRefresh").addEventListener("click", refreshFirebaseManageList);

/* =========================================================================
   TEST MODE — reuses the game's engine (trigger/action/cascade + physics)
   directly on the level being edited, for an immediate round-trip.
   ========================================================================= */
let playRunning = false;
let P = null; // player state in test mode
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
      /* Makes the object visible and restores its original solidity —
         never forcing "hazard" to true: the danger only depends on
         whatever is checked in "Dangerous on contact" for THIS object. A
         hidden spike is configured hazard=true from the start (but stays
         harmless while invisible, since the damage check requires both);
         a normal wall stays hazard=false and simply goes back to being one. */
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
      /* Each MOVE only drives the axis matching its direction
         (left/right => X, up/down => Y), without touching the other axis —
         two MOVEs on different axes add up into a diagonal instead of
         cancelling out. A second MOVE on the SAME axis cleanly replaces
         cleanly replaces the first (expected behavior). */
      {
        obj.moveTarget = null;
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
    case "MOVE_TO":
      /* Moves the object directly to a given (x,y) position, at a given
         speed (with optional acceleration) — the duration is derived from
         the distance, instead of having to calculate it by hand. */
      obj.moveX = null; obj.moveY = null;
      obj.moveTarget = {
        tx: action.x!=null?action.x:obj.x, ty: action.y!=null?action.y:obj.y,
        speed: action.speed!=null?action.speed:100, accel: action.acceleration||0,
        speedCur: action.acceleration ? 0 : (action.speed!=null?action.speed:100),
      };
      obj.state = "moving";
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
/* Actions on the special SCENE and PLAYER targets (cf. SCENE_ACTION_TYPES /
   PLAYER_ACTION_TYPES). Kept separate from playApplyAction because neither the scene nor the
   player are level objects. */
function applySceneAction(action){
  if(action.type==="SET_GRAVITY"){
    currentGravity = action.value!=null ? action.value : DEFAULT_GRAVITY;
  } else if(action.type==="SET_SPEED"){
    currentMoveSpeed = action.value!=null ? action.value : DEFAULT_MOVE_SPEED;
  } else if(action.type==="SET_CONTROLS"){
    controlsInverted = (action.value==="inverted");
  }
}
const PLAYER_BASE_W = 26, PLAYER_BASE_H = 38;
function applyPlayerAction(action){
  if(action.type==="CHANGE_WIDTH"){
    const newW = action.value!=null ? action.value : PLAYER_BASE_W;
    const newH = newW * (PLAYER_BASE_H/PLAYER_BASE_W);
    P.x += (P.w-newW)/2; P.y += (P.h-newH);
    P.w = newW; P.h = newH;
  } else if(action.type==="CHANGE_HEIGHT"){
    const newH = action.value!=null ? action.value : PLAYER_BASE_H;
    const newW = newH * (PLAYER_BASE_W/PLAYER_BASE_H);
    P.y += (P.h-newH); P.x += (P.w-newW)/2;
    P.w = newW; P.h = newH;
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
  /* Each cascade link applies independently, even if the target has
     already received an action from another link (e.g. a first link that
     makes it appear, a second that makes it move). `triggered` only
     prevents the target's OWN trigger from firing again on its own — it
     must never block an explicit cascade from being applied. */
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
/* Determines from which side(s) a box (prevBox) that wasn't overlapping
   `obj` entered into overlap with `obj`, by comparing it to its
   post-movement position (newBox). Used by the ON_ENTER trigger with a required direction. */
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
      const box = effectiveBox(obj);
      if(!playOverlap(P, box)) return false;
      if(!t.fromSide) return true;
      if(playPrevBox && playOverlap(playPrevBox, box)) return false; // already inside, not an "entry"
      const sides = playPrevBox ? enteredFromSides(playPrevBox, P, box) : [];
      return sides.includes(t.fromSide);
    }
    case "ON_JUMP": return P.justJumped && playOverlap(P, effectiveBox(obj));
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
  playObjects = JSON.parse(JSON.stringify(lvl.objects)).map(o=>Object.assign({visible:true,hazard:!!o.hazard,triggered:false,state:"idle",pressPhase:0}, o));
  playObjectsById = {};
  for(const o of lvl.objects) playObjectsById[o.id]=o;
  P = { x:lvl.playerStart.x, y:lvl.playerStart.y, w:26, h:38, vx:0, vy:0, grounded:false, groundedOn:null,
    prevGroundedOn:null, justLandedOn:null, justJumped:false, lastBump:null, lastGroundY:null, moveX:null, moveY:null, facing:1 };
  playTimers=[]; playNow=0; playMode="playing"; playLastCause=null; walkPhase=0; playPrevBox=null;
  currentGravity = lvl.gravity!=null ? lvl.gravity : DEFAULT_GRAVITY;
  currentMoveSpeed = DEFAULT_MOVE_SPEED;
  controlsInverted = false;
  initClouds();
  hidePlayMsg();
}
/* An object's effective collision box: for a rotating object, we use the
   axis-aligned rectangle that exactly bounds its rotated shape (it grows/
   shrinks with the angle). This is a simple approximation (not real
   oriented-rectangle collision), but it keeps the physics consistent
   with the visual rendering: the player can climb onto
   climb onto a rotating platform and its support height follows the tilt. */
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
  /* fallSign = direction of current gravity (1 = normal, -1 = inverted).
     All the resolution below is symmetric with respect to this sign:
     with inverted gravity, "landing" means sticking to the UNDERSIDE
     from a platform (the ground is at the ceiling), and the jump catch-up
     applies toward a lower platform (in the direction opposite to
     gravity) rather than a higher one. */
  const fallSign = currentGravity >= 0 ? 1 : -1;
  const prevBottom=P.y+P.h, prevTop=P.y;
  P.x += P.vx*dt; P.y += P.vy*dt;
  P.grounded=false; P.groundedOn=null;
  for(const o of playObjects){
    /* An invisible object doesn't block physically by default (otherwise
       a trap the player successfully avoided would keep getting in the
       way) — unless "Solid even hidden" is explicitly checked. */
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
      /* Step-up assist: measured against the position BEFORE this frame's movement
         (measured against the position before this frame's movement), and only for climbing onto a platform
         noticeably closer to the "effective ceiling" than the one just
         (a jump that's just barely too short) — never to plug a
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

  /* Exit (pipe): solid on the sides — blocks like a wall — but its top
     (the opening, in the direction opposite to gravity) wins the level as
     soon as the player enters it by falling/jumping in. Same fallSign logic
     as the rest of the function, same mechanic as the real game (engine.js). */
  playResolveExit(fallSign, prevBottom, prevTop);

  /* Chute au centre plutôt qu'au coin arrière — même correctif que le jeu
     (engine.js) : le joueur perd "grounded" dès que son point central
     n'a plus de support, même si sa boîte complète chevauche encore. */
  if(P.grounded){
    const centerX = P.x + P.w/2;
    const checkY = fallSign > 0 ? P.y + P.h + 1 : P.y - 1;
    let supported = false;
    for(const o of playObjects){
      if(!o.solid) continue;
      if(o.visible === false && !o.solidWhenHidden) continue;
      const box = effectiveBox(o);
      if(centerX >= box.x && centerX <= box.x+box.w && checkY >= box.y && checkY <= box.y+box.h){ supported = true; break; }
    }
    if(!supported){
      const e = curLevel().exit;
      if(centerX >= e.x && centerX <= e.x+e.w && checkY >= e.y && checkY <= e.y+e.h) supported = true;
    }
    if(!supported){ P.grounded = false; P.groundedOn = null; }
  }
}
function playResolveExit(fallSign, prevBottom, prevTop){
  const e = curLevel().exit;
  if(!playOverlap(P, e)) return;

  if(fallSign > 0){
    if(P.vy >= 0 && prevBottom <= e.y + 10){ playWin(); return; }
  } else {
    if(P.vy <= 0 && prevTop >= e.y + e.h - 10){ playWin(); return; }
  }

  const overlapX = Math.min(P.x+P.w, e.x+e.w) - Math.max(P.x, e.x);
  const overlapY = Math.min(P.y+P.h, e.y+e.h) - Math.max(P.y, e.y);
  if(overlapX < overlapY){
    if(P.x < e.x) P.x -= overlapX; else P.x += overlapX;
    P.vx = 0;
  } else {
    if(fallSign > 0){
      if(P.y < e.y){ playWin(); return; }
      else { P.y += overlapY; P.vy = 0; }
    } else {
      if(P.y + P.h > e.y + e.h){ playWin(); return; }
      else { P.y -= overlapY; P.vy = 0; }
    }
  }
}
function playWin(){
  playMode="won";
  setTimeout(()=>{ if(playRunning) playBuildLevel(); }, 1300);
}
let playPrevBox = null;
function playUpdate(dt){
  playNow += dt*1000; playProcessTimers();
  playPrevBox = { x:P.x, y:P.y, w:P.w, h:P.h };

  /* Animated objects, before collision resolution (the player stands
     on a moving platform's up-to-date position this frame). */
  for(const o of playObjects){
    o._lastDX = 0; o._lastDY = 0;
    if(o.state==="falling"){
      o.y += o.fallSpeed*dt; if(o.y>H+100){ o.visible=false; o.dead=true; }
    }
    /* moveX and moveY are two independent "engines" (one per axis): a
       a horizontal move and a vertical move can tourner
       IN PARALLEL on the same object (e.g. MOVE right for 1000ms +
       MOVE up offset by 200ms => a diagonal), instead of overwriting
       overwriting one another. */
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
    if(o.moveTarget){
      const mt = o.moveTarget;
      const ddx = mt.tx-o.x, ddy = mt.ty-o.y;
      const dist = Math.hypot(ddx,ddy);
      if(dist<0.5){
        o.x=mt.tx; o.y=mt.ty; o.moveTarget=null;
        if(!o.moveX && !o.moveY) o.state="idle";
      } else {
        mt.speedCur = mt.accel ? approach(mt.speedCur, mt.speed, mt.accel*dt) : mt.speed;
        const step = mt.speedCur*dt;
        let sx,sy;
        if(step>=dist){ o.x=mt.tx; o.y=mt.ty; o.moveTarget=null; if(!o.moveX && !o.moveY) o.state="idle"; sx=ddx; sy=ddy; }
        else { const ux=ddx/dist, uy=ddy/dist; sx=ux*step; sy=uy*step; o.x+=sx; o.y+=sy; }
        o._lastDX += sx; o._lastDY += sy;
      }
    }
    if(o.state==="rotating"){
      o.angle = (o.angle||0) + (o.rotateSpeed||0)*dt;
    }
    if(o.kind==="button"){
      const pressed = o.triggered || playOverlap(P,o);
      o.pressPhase = approach(o.pressPhase||0, pressed?1:0, dt/0.12);
    }
  }

  P.vx = (playInput.right?1:0)-(playInput.left?1:0);
  if(controlsInverted) P.vx = -P.vx;
  P.vx *= currentMoveSpeed;
  if(P.vx>0) P.facing=1; else if(P.vx<0) P.facing=-1;
  walkPhase += Math.abs(P.vx)*dt*0.15;
  if(Math.abs(P.vx) < 1) walkPhase = 0;
  P.justJumped=false;
  if(playInput.jumpQueued && P.grounded){
    /* The jump always pushes OPPOSITE to the direction of current gravity:
       with inverted gravity (stuck to the ceiling), jumping pushes
       downward, not upward. */
    P.vy = currentGravity>=0 ? JUMP_VELOCITY : -JUMP_VELOCITY;
    P.grounded=false; P.groundedOn=null; P.justJumped=true;
  }
  playInput.jumpQueued=false;

  /* Impulsion externe (action MOVE ciblant PLAYER, cf. applyPlayerAction) :
     adds to the movement driven by the keys, without ever overwriting it —
     same two-independent-axis logic as for objects. */
  if(P.moveX){
    P.moveX.v = P.moveX.accel ? approach(P.moveX.v, P.moveX.target, P.moveX.accel*dt) : P.moveX.target;
    P.vx += P.moveX.v;
  }
  if(P.moveY){
    P.moveY.v = P.moveY.accel ? approach(P.moveY.v, P.moveY.target, P.moveY.accel*dt) : P.moveY.target;
    P.vy += P.moveY.v;
  }

  /* Physics substeps: at 240px/s and 60 fps, one frame moves the player
     4px, and their body is 26px wide — the real gap to cross without
     no contact at all (gap width minus player width) is often
     smaller than a single step, so it's crossed in one go before gravity
     has had time to accumulate. Recomputing gravity and collision
     several times per frame (instead of once with the full dt) gives
     several times per frame gives a visually continuous fall and correctly detects small gaps. */
  const SUBSTEPS = 4;
  const subDt = dt / SUBSTEPS;
  for(let s=0; s<SUBSTEPS; s++){
    P.vy += currentGravity*subDt;
    if(P.vy>MAX_FALL) P.vy=MAX_FALL;
    if(P.vy<-MAX_FALL) P.vy=-MAX_FALL;
    playResolve(subDt);
  }

  /* Carried by a moving platform. */
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
  if(P.y>H+60){ playDeath(null); return; }
  for(const o of playObjects){ if(o.hazard && o.visible!==false && playOverlap(P,effectiveBox(o))){ playDeath(o); return; } }
}
function playDeath(obj){
  playMode="dead"; playAttempts++;
  let cause=obj;
  if(!cause && P.lastBump && (playNow-P.lastBump.t)<1500) cause = playObjectsById[P.lastBump.id];
  playLastCause = cause ? (cause.description||"A trap got you.") : "You fell into the void.";
  spawnDeathExplosion(P.x+P.w/2, P.y+P.h/2);
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
    case "static": case "decoy": drawBlockTile(o.x,o.y,o.w,o.h); break;
    case "falling":
      drawBlockTile(o.x,o.y,o.w,o.h);
      if(o.state==="shaking"||o.state==="falling"){ ctx.strokeStyle="rgba(40,20,10,.55)"; ctx.lineWidth=1.5;
        ctx.beginPath(); ctx.moveTo(o.x+o.w*0.32,o.y+2); ctx.lineTo(o.x+o.w*0.45,o.y+o.h*0.6); ctx.lineTo(o.x+o.w*0.38,o.y+o.h-2); ctx.stroke(); }
      break;
    case "gate": drawBlockTile(o.x,o.y,o.w,o.h); break;
    case "blocker": drawBlockTile(o.x,o.y,o.w,o.h); ctx.strokeStyle="rgba(224,69,92,.55)"; ctx.lineWidth=2; ctx.strokeRect(o.x+1,o.y+1,o.w-2,o.h-2); break;
    case "hidden_spike":
      if(o.hazard){ drawPlantRow(o.x,o.y,o.w,o.h); }
      else if(invisible){ ctx.save(); ctx.globalAlpha=0.35; drawPlantRow(o.x,o.y,o.w,o.h); ctx.restore(); }
      break;
    case "door":
      drawDoorShape(o.x,o.y,o.w,o.h, "#3d5af1", "#eef0ff", "#1f2d8a");
      break;
    case "button":
      drawButtonSpriteEd(o);
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
/* Player character: a simple stick figure (round head, torso, arms,
   legs) that animates while walking and takes a different pose in the air —
   drawn in LOCAL coordinates (origin = center of the player's box,
   already translated/flipped by the caller according to P.facing). */
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

  // head
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
/* Only returns the playable area (between the boundary walls): everything that
   is outside this zone (the walls themselves, and beyond) stays black —
   as if the boundaries were the very frame of the screen. If a level doesn't
   have (or no longer has) its default walls, falls back to the full 800x450 world. */
function computePlayArea(){
  const top = playObjects.find(o=>o.id==="_boundTop");
  const left = playObjects.find(o=>o.id==="_boundLeft");
  const right = playObjects.find(o=>o.id==="_boundRight");
  const x0 = left ? left.x+left.w : 0;
  const y0 = top ? top.y+top.h : 0;
  const x1 = right ? right.x : W;
  /* No boundary wall at the bottom (by design) — the bottom black bar is purely a
     crop, aligned to the top wall's real thickness to stay
     consistent with the other three sides regardless of the level. */
  const bottomMargin = top ? top.h : (left ? left.w : 20);
  const y1 = H - bottomMargin;
  return { x:x0, y:y0, w:Math.max(1,x1-x0), h:Math.max(1,y1-y0) };
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

  ctx.fillStyle = SKY_COLOR;
  ctx.fillRect(0,0,W,H);
  drawClouds();
  const lvl = curLevel(); const ex = lvl.exit;
  drawExitSprite(ex.x,ex.y,ex.w,ex.h, playMode);
  for(const o of playObjects) drawPlayObject(o);
  drawPlayMario();
  drawParticles();
  ctx.restore();
}
/* Mario sprite if the image is loaded, otherwise falls back to the
   stick-figure silhouette — same logic as render.js (duplicated: a different canvas context
   distinct `ctx`, variables `P`/`playMode` au lieu de `player`/`mode`). */
function drawPlayMario(){
  if(playMode==="dead") return;
  const facingRight = P.facing >= 0;
  const sinkY = playerButtonSinkOffset();
  let img;
  if(!P.grounded){
    img = facingRight ? MARIO_SPRITES.jumpR : MARIO_SPRITES.jumpL;
  } else if(playInput.left || playInput.right){
    const set = facingRight ? MARIO_SPRITES.walkR : MARIO_SPRITES.walkL;
    img = set[Math.floor(walkPhase*0.6) % set.length];
  } else {
    img = facingRight ? MARIO_SPRITES.idleR : MARIO_SPRITES.idleL;
  }

  if(!img || !img.complete || !img.naturalWidth){
    ctx.save();
    ctx.translate(P.x+P.w/2, P.y+P.h/2+sinkY); ctx.scale(P.facing, currentGravity<0 ? -1 : 1);
    drawStickFigure(P.w, P.h, P.grounded, walkPhase, playMode==="dead", Math.min(1, Math.abs(P.vx)/80));
    ctx.restore();
    return;
  }

  const scale = P.h / img.naturalHeight;
  const dw = img.naturalWidth*scale, dh = img.naturalHeight*scale;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if(playMode==="dead") ctx.globalAlpha = 0.55;
  ctx.translate(P.x+P.w/2, P.y+P.h/2+sinkY);
  if(currentGravity<0) ctx.scale(1,-1);
  ctx.drawImage(img, -dw/2, P.h/2-dh, dw, dh);
  ctx.restore();
}
let playLastTs=null;
function playFrame(ts){
  if(!playRunning) return;
  if(playLastTs===null) playLastTs=ts;
  let dt=(ts-playLastTs)/1000; playLastTs=ts; if(dt>1/30) dt=1/30;
  updateParticles(dt);
  updatePlayClouds(dt);
  if(playMode==="playing") playUpdate(dt);
  renderPlay();
  requestAnimationFrame(playFrame);
}
const playOverlayMsg = null;
function showPlayMsg(){}
function hidePlayMsg(){}

const btnPlay = document.getElementById("btnPlay");
const playControlsEl = document.getElementById("playControls");
function startPlay(){
  /* Important: if keyboard focus stayed on a field in the properties
     panel (after editing a parameter), the left/right arrows would
     move that field's text cursor/selection instead of
     controlling the player — which makes the game feel stuck.
     Focus is explicitly removed when entering test mode. */
  if(document.activeElement && document.activeElement.blur) document.activeElement.blur();
  playRunning = true; playAttempts=0; playLastTs=null;
  playBuildLevel();
  playControlsEl.classList.add("show");
  document.getElementById("showHiddenToggle").classList.add("show");
  btnPlay.textContent = "■ Back to editing";
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
  btnPlay.textContent = "▶ Test level";
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
/* setPointerCapture: only a real finger release (pointerup/cancel)
   stops the command. Without this, the tiniest tremor that drifts
   outside the button fires "pointerleave" and cuts the key while the
   finger is still down — combined with mobile long-press trying to select
   the button's text, this made the game feel like it was getting stuck. */
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

/* ---------------------------- Startup ---------------------------- */
document.getElementById("btnZoomIn").addEventListener("click", ()=>{ setZoom(view.zoom*1.25, canvas.width/2, canvas.height/2); render(); });
document.getElementById("btnZoomOut").addEventListener("click", ()=>{ setZoom(view.zoom/1.25, canvas.width/2, canvas.height/2); render(); });
document.getElementById("btnZoomReset").addEventListener("click", ()=>{ fitView(); render(); });
document.getElementById("btnPanMode").addEventListener("click", (e)=>{
  panModeOn = !panModeOn;
  e.currentTarget.classList.toggle("active", panModeOn);
  canvas.style.cursor = panModeOn ? "grab" : "";
});
/* "Ordinary" window resize (desktop): keeps the current zoom/pan,
   just the canvas resolution follows. A genuine orientation
   d'ORIENTATION (portrait <-> paysage, typiquement en tournant le
   change (portrait <-> landscape, typically by rotating the
   phone — whether in an installed PWA or a plain browser tab)
   recrops the view to the screen's new shape, otherwise the content
   would stay poorly framed (over-zoomed, offset) after rotating. */
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
  // On some mobile browsers, the dimensions aren't updated yet
  // at the exact moment of the event — a small delay makes the measurement reliable.
  setTimeout(handleViewportChange, 150);
});

buildPalette();
renderLevelMeta();
renderInspector();
resizeCanvasToContainer();
fitView();
render();
