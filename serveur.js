#!/usr/bin/env node
// ============================================================================
//  Serveur du jeu de poursuite urbaine — fichier unique, zéro dépendance.
//  Node 18+.  Démarrage : node serveur.js
//
//  Variables d'environnement :
//    PORT         port d'écoute (Render le fournit, défaut 10000)
//    RENDER_DISK  chemin du disque persistant (ex. /var/donnees)
//    DONNEES      chemin explicite du journal, prioritaire
//
//  Vérifié par 123 tests (salon, protocole, chaos réseau) dans le dépôt source.
// ============================================================================
'use strict';
const http = require('node:http');
const url = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------- persistance ----------
// Persistance : journal append-only + index en mémoire, reconstruit au démarrage.
// Volontairement sans dépendance : ce qui est testé ici est exactement ce qui
// tournera en production. L'interface est étroite exprès — la remplacer par
// Postgres plus tard ne touche que ce fichier.

class Boutique {
  constructor(fichier) {
    this.fichier = fichier;
    this.index = new Map();          // cle -> donnees
    this.lignes = 0;
    if (fichier) {
      fs.mkdirSync(path.dirname(fichier), { recursive: true });
      this._rejouer();
      this.ouvert = true;
    }
  }
  _rejouer() {
    if (!fs.existsSync(this.fichier)) return;
    const brut = fs.readFileSync(this.fichier, 'utf8');
    for (const ligne of brut.split('\n')) {
      if (!ligne.trim()) continue;
      let e;
      try { e = JSON.parse(ligne); } catch (err) { continue; }  // ligne tronquée = ignorée
      this.lignes++;
      if (e.op === 'set') this.index.set(e.cle, e.val);
      else if (e.op === 'del') this.index.delete(e.cle);
    }
  }
  ecrire(cle, val) {
    this.index.set(cle, val);
    // Écriture SYNCHRONE : quand ecrire() rend la main, c'est sur le disque.
    // Un serveur qui tombe juste après ne perd pas le salon.
    if (this.ouvert) fs.appendFileSync(this.fichier, JSON.stringify({ op: 'set', cle, val }) + '\n');
    this.lignes++;
    if (this.lignes > 4000) this.compacter();
    return val;
  }
  lire(cle) { return this.index.get(cle) ?? null; }
  supprimer(cle) {
    this.index.delete(cle);
    if (this.ouvert) fs.appendFileSync(this.fichier, JSON.stringify({ op: 'del', cle }) + '\n');
  }
  cles(prefixe = '') { return [...this.index.keys()].filter(k => k.startsWith(prefixe)); }
  compacter() {
    if (!this.fichier) return;
    const tmp = this.fichier + '.tmp';
    const lignes = [...this.index].map(([cle, val]) => JSON.stringify({ op: 'set', cle, val }));
    fs.writeFileSync(tmp, lignes.join('\n') + (lignes.length ? '\n' : ''));
    fs.renameSync(tmp, this.fichier);       // remplacement atomique
    this.lignes = lignes.length;
  }
  fermer() { this.ouvert = false; }
}

// ---------- logique de salon ----------
const S = (() => {
// Le salon : objet serveur durable, créé AVANT que quiconque n'arrive.
// Logique pure — aucune I/O, aucun réseau. Testable seule.

// Alphabet sans caractères confondables (ni 0/O, ni 1/I/L) : le code se dit à voix haute.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const VERSION_PROTOCOLE = 1;

function codeSalon(n = 6) {
  const o = crypto.randomBytes(n);
  return [...o].map(b => ALPHABET[b % ALPHABET.length]).join('');
}
const identifiant = () => crypto.randomBytes(16).toString('hex');

const CONTROLES = ['localisation', 'gps', 'horloge', 'liaison', 'version'];

function creerSalon({ code, terrain = 'lognes', duree_min = 30, effectif = 6,
                      version = VERSION_PROTOCOLE, maintenant = Date.now() }) {
  return {
    code, terrain, duree_min, effectif, version,
    cree: maintenant, depart: null, finie: false,
    joueurs: {},               // joueurId -> {nom, camp, patrouille, profil, controles, vuA, version}
    ordre: [],                 // ordre d'arrivée, stable
    composition_validee: false,
  };
}

// Rejoindre est IDEMPOTENT : le même joueurId revient à sa place, avant ou
// pendant la partie. C'est ce qui fait qu'un téléphone qui redémarre retrouve
// son salon au lieu d'en créer un fantôme.
function rejoindre(salon, { joueurId, nom, profil = null, version = VERSION_PROTOCOLE,
                            maintenant = Date.now() }) {
  if (version !== salon.version) {
    return { ok: false, code: 'version_incompatible',
      message: `Cette partie tourne en version ${salon.version}, ton app est en version ${version}. Mets à jour l’app pour rejoindre.` };
  }
  const id = joueurId || identifiant();
  const existant = salon.joueurs[id];
  if (existant) {
    existant.vuA = maintenant;
    if (nom) existant.nom = nom;
    if (profil) existant.profil = profil;
    return { ok: true, joueurId: id, joueur: existant, retour: true,
      enCours: salon.depart != null && !salon.finie };
  }
  if (salon.depart != null && Object.keys(salon.joueurs).length >= salon.effectif + 6) {
    return { ok: false, code: 'salon_plein',
      message: 'Cette partie est complète. Demande un nouveau lien.' };
  }
  const j = { nom: nom || 'Joueur', profil, camp: null, patrouille: null,
              controles: {}, vuA: maintenant, arrive: maintenant,
              retardataire: salon.depart != null, version };
  salon.joueurs[id] = j; salon.ordre.push(id);
  return { ok: true, joueurId: id, joueur: j, retour: false,
           enCours: salon.depart != null && !salon.finie };
}

function marquerControle(salon, joueurId, nom, valeur, maintenant = Date.now()) {
  const j = salon.joueurs[joueurId];
  if (!j) return false;
  if (!CONTROLES.includes(nom)) return false;
  j.controles[nom] = !!valeur; j.vuA = maintenant;
  return true;
}

const allureDe = j => (j.profil && j.profil.a5) ? j.profil.a5 : 360;  // s/km, défaut prudent

// Le serveur équilibre, l'hôte peut corriger : on répartit en serpentin sur
// l'allure, ce qui égalise les moyennes bien mieux qu'un tirage.
function composer(salon) {
  const ids = salon.ordre.filter(id => salon.joueurs[id]);
  const tries = [...ids].sort((a, b) => allureDe(salon.joueurs[a]) - allureDe(salon.joueurs[b]));
  tries.forEach((id, i) => {
    const cycle = Math.floor(i / 2);
    salon.joueurs[id].camp = (cycle % 2 === 0) ? (i % 2) : (1 - (i % 2));  // serpentin
  });
  for (const camp of [0, 1]) {
    const membres = tries.filter(id => salon.joueurs[id].camp === camp);
    membres.forEach((id, i) => { salon.joueurs[id].patrouille = Math.floor(i / 3); });
  }
  return equilibre(salon);
}

function equilibre(salon) {
  const moy = camp => {
    const v = Object.values(salon.joueurs).filter(j => j.camp === camp).map(allureDe);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const a = moy(0), b = moy(1);
  if (a == null || b == null) return { ecart: null, ok: false, camps: [a, b] };
  const ecart = Math.abs(a - b) / Math.min(a, b);
  return { ecart, ok: ecart <= 0.10, camps: [a, b],
    message: ecart <= 0.10 ? null
      : `Les deux camps ont ${(ecart * 100).toFixed(0)} % d’écart d’allure. Au-delà de 10 %, la poursuite risque de ne jamais se conclure.` };
}

// Vue publique du salon : ce que TOUT LE MONDE voit, y compris les contrôles
// de chacun. C'est la leçon de l'app pompiers — l'échec doit être lisible.
function vuePublique(salon, maintenant = Date.now()) {
  return {
    code: salon.code, terrain: salon.terrain, duree_min: salon.duree_min,
    effectif: salon.effectif, version: salon.version,
    depart: salon.depart, finie: salon.finie,
    composition_validee: salon.composition_validee,
    equilibre: equilibre(salon),
    joueurs: salon.ordre.filter(id => salon.joueurs[id]).map(id => {
      const j = salon.joueurs[id];
      const manquants = CONTROLES.filter(c => !j.controles[c]);
      return {
        id, nom: j.nom, camp: j.camp, patrouille: j.patrouille,
        retardataire: !!j.retardataire,
        silencieux: maintenant - j.vuA > 90000,
        prêt: manquants.length === 0,
        manquants,
        // Pourquoi il n'est pas prêt, en toutes lettres :
        raison: manquants.length ? ({
          localisation: 'autorisation de localisation refusée ou en attente',
          gps: 'pas encore de point GPS',
          horloge: 'horloge pas encore synchronisée',
          liaison: 'pas de liaison avec le serveur',
          version: 'version de l’app à vérifier',
        })[manquants[0]] : null,
      };
    }),
  };
}

function peutDemarrer(salon) {
  const v = vuePublique(salon);
  const prets = v.joueurs.filter(j => j.prêt && !j.silencieux);
  if (prets.length < 2) return { ok: false, message: 'Il faut au moins 2 joueurs prêts pour lancer.' };
  if (!salon.composition_validee) return { ok: false, message: 'La composition des camps n’a pas encore été validée.' };
  return { ok: true, prets: prets.length };
}


  return { VERSION_PROTOCOLE, CONTROLES, codeSalon, identifiant, creerSalon, rejoindre,
           marquerControle, composer, equilibre, vuePublique, peutDemarrer, allureDe };
})();

// ---------- ville et poursuite ----------
// Ville générée : graphe de rues jouable, déterministe par graine.
// Grille irrégulière avec des rues manquantes — le modèle validé par
// check_routes.py (grille 30x30, 12 % de suppression).

function rngFab(seed){ // mulberry32
  let a=seed>>>0;
  return function(){ a|=0; a=a+0x6D2B79F5|0;
    let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t;
    return ((t^t>>>14)>>>0)/4294967296; };
}

class Ville{
  constructor(opts={}){
    if(opts.data){ this._charger(opts.data); return; }
    const n=opts.n??22, pas=opts.pas??110, suppr=opts.suppr??0.13,
          jit=opts.jitter??0.22, rng=rngFab(opts.graine??7);
    this.n=n; this.pas=pas;
    this.pos=[]; this.adj=[];              // index -> {x,y} ; index -> Map(voisin->longueur)
    const id=(i,j)=>i*n+j;
    for(let i=0;i<n;i++)for(let j=0;j<n;j++)
      this.pos.push({x:i*pas+(rng()-.5)*2*jit*pas, y:j*pas+(rng()-.5)*2*jit*pas});
    for(let k=0;k<n*n;k++) this.adj.push(new Map());
    const lier=(a,b)=>{const d=Math.hypot(this.pos[a].x-this.pos[b].x,this.pos[a].y-this.pos[b].y);
      this.adj[a].set(b,d); this.adj[b].set(a,d);};
    for(let i=0;i<n;i++)for(let j=0;j<n;j++){
      if(i+1<n && rng()>suppr) lier(id(i,j),id(i+1,j));
      if(j+1<n && rng()>suppr) lier(id(i,j),id(i,j+1));
    }
    // on ne garde que la plus grande composante connexe
    const comp=new Int32Array(n*n).fill(-1); let nc=0, tailles=[];
    for(let s=0;s<n*n;s++){
      if(comp[s]!==-1||this.adj[s].size===0){ if(this.adj[s].size===0)comp[s]=-2; continue; }
      let taille=0; const pile=[s]; comp[s]=nc;
      while(pile.length){ const u=pile.pop(); taille++;
        for(const v of this.adj[u].keys()) if(comp[v]===-1){comp[v]=nc;pile.push(v);} }
      tailles.push(taille); nc++;
    }
    const best=tailles.indexOf(Math.max(...tailles));
    for(let k=0;k<n*n;k++) if(comp[k]!==best) this.adj[k]=new Map();
    this.noeuds=[...Array(n*n).keys()].filter(k=>this.adj[k].size>0);
    this._barycentre();
  }
  _charger(d){
    // réseau réel : {noeuds:[[x,y],...], aretes:[[a,b],...]} en mètres locaux
    this.pos=d.noeuds.map(p=>({x:p[0], y:-p[1]}));   // y écran vers le bas
    this.adj=this.pos.map(()=>new Map());
    for(const [a,b] of d.aretes){
      const w=Math.hypot(this.pos[a].x-this.pos[b].x, this.pos[a].y-this.pos[b].y);
      if(w<=0) continue;
      this.adj[a].set(b,w); this.adj[b].set(a,w);
    }
    this.noeuds=[...this.adj.keys()].filter(k=>this.adj[k].size>0);
    this.nom=d.nom||null;
    this._barycentre();
  }
  _barycentre(){
    let sx=0,sy=0; for(const k of this.noeuds){sx+=this.pos[k].x;sy+=this.pos[k].y;}
    this.centre={x:sx/this.noeuds.length, y:sy/this.noeuds.length};
  }
  plusProche(x,y){ let b=-1,bd=1e18;
    for(const k of this.noeuds){ const d=(this.pos[k].x-x)**2+(this.pos[k].y-y)**2;
      if(d<bd){bd=d;b=k;} } return b; }
  dijkstra(src, interdit=null){
    const dist=new Map([[src,0]]), prev=new Map(), tas=[[0,src]];
    while(tas.length){
      let bi=0; for(let i=1;i<tas.length;i++) if(tas[i][0]<tas[bi][0]) bi=i;
      const [d,u]=tas.splice(bi,1)[0];
      if(d>(dist.get(u)??1e18)) continue;
      for(const [v,w] of this.adj[u]){
        if(interdit&&interdit(v)) continue;
        const nd=d+w;
        if(nd<(dist.get(v)??1e18)){ dist.set(v,nd); prev.set(v,u); tas.push([nd,v]); }
      }
    }
    return {dist,prev};
  }
  chemin(src,dst,interdit=null){
    const {dist,prev}=this.dijkstra(src,interdit);
    if(!dist.has(dst)) return null;
    const c=[dst]; let u=dst;
    while(u!==src){ u=prev.get(u); c.push(u); }
    return c.reverse();
  }
}

// Marcheur : avance le long d'une suite de nœuds à une vitesse donnée (m/s).
class Marcheur{
  constructor(ville, depart){ this.v=ville; this.noeud=depart; this.suiv=null;
    this.frac=0; this.x=ville.pos[depart].x; this.y=ville.pos[depart].y;
    this.chemin=[]; this.parcourues=new Set(); }
  cap(chemin){ if(chemin&&chemin.length>1&&chemin[0]===this.noeud){ this.chemin=chemin.slice(1); } }
  avancer(vitesse, dt){
    let reste=vitesse*dt;
    while(reste>0){
      if(this.suiv==null){
        if(!this.chemin.length) break;
        this.suiv=this.chemin.shift();
        if(!this.v.adj[this.noeud].has(this.suiv)){ this.suiv=null; this.chemin=[]; break; }
        this.frac=0;
      }
      const L=this.v.adj[this.noeud].get(this.suiv);
      const restant=(1-this.frac)*L;
      if(reste>=restant){
        reste-=restant;
        const a=Math.min(this.noeud,this.suiv), b=Math.max(this.noeud,this.suiv);
        this.parcourues.add(a+'-'+b);
        this.noeud=this.suiv; this.suiv=null; this.frac=0;
      } else { this.frac+=reste/L; reste=0; }
      const p=this.v.pos[this.noeud], q=this.suiv!=null?this.v.pos[this.suiv]:p;
      this.x=p.x+(q.x-p.x)*this.frac; this.y=p.y+(q.y-p.y)*this.frac;
    }
  }
}

// La chasse sur la carte : patrouille IA, brouillard en 3 actes, capture,
// bascule des rôles, zone qui se ferme, rues découvertes.

/* cadence (pas/min) -> vitesse (m/s). [PARAMÈTRE] : 128 spm (trot) ~ 6 km/h,
   170 spm ~ 10 km/h, linéaire entre, plancher marche sous 100 spm. */
function vitesse(spm){
  if(spm==null) return 0;
  if(spm<100) return 1.0*spm/100;                 // marche lente
  const kmh=Math.max(3.5, 0.0952*spm-6.19);       // 128->6,0 ; 170->10,0 ; 184->11,3
  return kmh/3.6;
}

class Partie{
  constructor(opts={}){
    this.v=opts.ville??new Ville({graine:opts.graine??7});
    this.duree=(opts.duree_min??30)*60;
    this.niv=opts.niv??{P:9,re:5,rp:6,phase:3};
    this.circuite=opts.circuite??1.30;
    this.Rcapture=opts.Rcapture??20;
    this.tPing=opts.tPing??180;
    this.fermeture=opts.fermeture??0.667;         // début de fermeture (fraction du chrono)
    this.rayonFin=opts.rayonFin??250;
    // placements : joueur au hasard, patrouille à ~G_initial (200 m)
    const rnd=opts.rnd??(()=>Math.random());
    this.rnd=rnd;
    const nj=this.v.noeuds[Math.floor(rnd()*this.v.noeuds.length)];
    this.joueur=new Marcheur(this.v,nj);
    const {dist}=this.v.dijkstra(nj);
    let cible=null, want=opts.G0??200, best=1e18;
    for(const [k,d] of dist){ const e=Math.abs(d-want); if(e<best){best=e;cible=k;} }
    this.patrouille=new Marcheur(this.v,cible??nj);
    // Tes 2 coéquipiers : ils courent avec toi (la patrouille de la spec).
    this.coequipiers=[new Marcheur(this.v,nj), new Marcheur(this.v,nj)];
    this.tracePatrouille=[];
    this.roleJoueur='fuite';
    this.t=0; this.captures=0; this.capturesSubies=0; this.capturesFaites=0;
    this.immunite=0; this.finie=false; this.tempsFuite=0; this.tempsChasse=0;
    this.echappes=0; this.timeoutChasse=600;  // 10 min sans conclure : ils t'échappent
    this.dernierPing={x:this.joueur.x,y:this.joueur.y,t:0};
    this.capJoueur=null;                          // direction demandée (angle) ou null
    this.rayon0=Math.max(...this.v.noeuds.map(k=>Math.hypot(
      this.v.pos[k].x-this.v.centre.x,this.v.pos[k].y-this.v.centre.y)))+50;
  }
  acte(){ const f=this.t/this.duree; return f<1/3?1:f<2/3?2:3; }
  rayonZone(){
    const f=this.t/this.duree;
    if(f<this.fermeture) return this.rayon0;
    const k=(f-this.fermeture)/(1-this.fermeture);
    return this.rayon0+(this.rayonFin-this.rayon0)*k;
  }
  horsZone(k){ const p=this.v.pos[k];
    return Math.hypot(p.x-this.v.centre.x,p.y-this.v.centre.y)>this.rayonZone(); }
  ecart(){ return Math.hypot(this.joueur.x-this.patrouille.x,this.joueur.y-this.patrouille.y); }

  // position adverse telle que VUE par le joueur, selon l'acte
  vueAdverse(){
    const a=this.acte();
    if(a===1) return {mode:'exact',x:this.patrouille.x,y:this.patrouille.y};
    if(a===2){ const d=this.ecart();
      return {mode:'halo',x:this.patrouille.x,y:this.patrouille.y,
              rayon:Math.max(40,Math.min(300,d*0.35))}; }
    return {mode:'ping',x:this.dernierPingAdv?.x??this.patrouille.x,
            y:this.dernierPingAdv?.y??this.patrouille.y,
            age:this.t-(this.dernierPingAdv?.t??0)};
  }

  capVersAngle(m,angle){
    // choisit le voisin le mieux aligné avec l'angle demandé, sans demi-tour immédiat
    const ici=m.noeud, opts=[...this.v.adj[ici].keys()].filter(k=>!this.horsZone(k));
    if(!opts.length) return;
    let best=null,bs=-1e9;
    for(const k of opts){
      const dx=this.v.pos[k].x-this.v.pos[ici].x, dy=this.v.pos[k].y-this.v.pos[ici].y;
      const s=Math.cos(angle)*dx/Math.hypot(dx,dy)+Math.sin(angle)*dy/Math.hypot(dx,dy);
      const demiTour=(m._prec===k)?-0.8:0;
      if(s+demiTour>bs){bs=s+demiTour;best=k;}
    }
    if(best!=null){ m._prec=ici; m.cap([ici,best]); }
  }

  tick(dt, spmJoueur, fenJoueur, fenAdv){
    if(this.finie) return;
    this.t+=dt;
    if(this.t>=this.duree){ this.finie=true; return; }
    if(this.roleJoueur==='fuite') this.tempsFuite+=dt; else this.tempsChasse+=dt;
    // Un chasseur qui ne conclut pas n'est pas condamné à chasser 25 min :
    // au bout du délai, la proie s'échappe et les rôles se réinversent.
    if(this.roleJoueur==='chasse' && this.tempsChasse>=this.timeoutChasse){
      this.tempsChasse=0; this.roleJoueur='fuite'; this.echappes++; this.immunite=20;
      return {echappe:true, capture:false};
    }
    // ping de l'acte 3 (position du fuyard connue du chasseur, et inversement)
    if(this.acte()===3){
      if(!this._ping || this.t-this._ping>=this.tPing){
        this._ping=this.t;
        this.dernierPing={x:this.joueur.x,y:this.joueur.y,t:this.t};
        this.dernierPingAdv={x:this.patrouille.x,y:this.patrouille.y,t:this.t};
      }
    } else {
      this.dernierPing={x:this.joueur.x,y:this.joueur.y,t:this.t};
      this.dernierPingAdv={x:this.patrouille.x,y:this.patrouille.y,t:this.t};
    }
    // vitesse du joueur : sa cadence ; celle de l'IA : profil fixe, fenêtres
    const vJ=(fenJoueur?vitesse(spmJoueur):Math.min(vitesse(spmJoueur),1.9));
    const vA=(fenAdv?10/3.6:6/3.6)/this.circuite;
    // cap du joueur
    if(this.joueur.suiv==null&&this.joueur.chemin.length===0){
      if(this.roleJoueur==='chasse'){
        const cible=this.v.plusProche(this.dernierPingAdv?.x??this.patrouille.x,
                                      this.dernierPingAdv?.y??this.patrouille.y);
        const c=this.v.chemin(this.joueur.noeud,cible,k=>this.horsZone(k));
        if(c&&c.length>1) this.joueur.cap(c.slice(0,3));
        else this.capVersAngle(this.joueur,this.rnd()*6.28);
      } else {
        this.capVersAngle(this.joueur,this.capJoueur??this.rnd()*6.28);
      }
    }
    // cap de l'IA
    if(this.patrouille.suiv==null&&this.patrouille.chemin.length===0){
      let cible;
      if(this.roleJoueur==='fuite'){
        cible=this.v.plusProche(this.dernierPing.x,this.dernierPing.y);   // elle te chasse
      } else {
        // elle fuit : regarde à deux coups (voisins de voisins) et vise le point
        // qui maximise la distance au joueur, dans la zone
        const ici=this.patrouille.noeud;
        let best=null,bd=-1;
        for(const k of this.v.adj[ici].keys()){
          if(this.horsZone(k)) continue;
          for(const k2 of this.v.adj[k].keys()){
            if(this.horsZone(k2)||k2===ici) continue;
            const d=Math.hypot(this.v.pos[k2].x-this.joueur.x,this.v.pos[k2].y-this.joueur.y);
            if(d>bd){bd=d;best=k2;}
          }
        }
        cible=best??ici;
      }
      const c=this.v.chemin(this.patrouille.noeud,cible,k=>this.horsZone(k));
      if(c&&c.length>1) this.patrouille.cap(c.slice(0,4));
    }
    this.joueur.avancer(vJ,dt);
    this.patrouille.avancer(vA,dt);
    // coéquipiers : ils suivent le joueur (laisse), à des allures proches
    for(let i=0;i<this.coequipiers.length;i++){
      const c=this.coequipiers[i];
      if(c.suiv==null&&c.chemin.length===0&&c.noeud!==this.joueur.noeud){
        const ch=this.v.chemin(c.noeud,this.joueur.noeud,k=>this.horsZone(k));
        if(ch&&ch.length>1)c.cap(ch.slice(0,4));
      }
      c.avancer(Math.min(vJ*(i===0?1.06:0.94), 10/3.6), dt);
    }
    // trace de la patrouille adverse : sert à dessiner ses 3 membres
    const tp=this.tracePatrouille;
    if(!tp.length||Math.hypot(tp[tp.length-1].x-this.patrouille.x,tp[tp.length-1].y-this.patrouille.y)>3){
      tp.push({x:this.patrouille.x,y:this.patrouille.y});
      if(tp.length>60)tp.shift();
    }
    // capture — avec période d'immunité après une bascule (l'arrêt imposé de la spec)
    if(this.immunite>0){ this.immunite-=dt; return {capture:false}; }
    if(this.ecart()<=this.Rcapture){
      this.captures++;
      if(this.roleJoueur==='fuite') this.capturesSubies++; else this.capturesFaites++;
      this.immunite=45; this.tempsChasse=0;
      this.roleJoueur=this.roleJoueur==='fuite'?'chasse':'fuite';
      // relance : l'ex-fuyard est replacé à G_relance
      const {dist}=this.v.dijkstra(this.joueur.noeud);
      let cible=null,best=1e18;
      for(const [k,d] of dist){ const e=Math.abs(d-150); if(e<best&&!this.horsZone(k)){best=e;cible=k;} }
      if(cible!=null){ this.patrouille.noeud=cible; this.patrouille.suiv=null;
        this.patrouille.chemin=[]; this.patrouille.x=this.v.pos[cible].x;
        this.patrouille.y=this.v.pos[cible].y; }
      return {capture:true};
    }
    return {capture:false};
  }
}
Partie.prototype.membresPatrouille=function(){
  // 3 membres : la tête + 2 échelonnés 14 et 28 m en arrière sur sa trace
  const out=[{x:this.patrouille.x,y:this.patrouille.y}];
  const tp=this.tracePatrouille;
  let d=0;
  for(let i=tp.length-1;i>0&&out.length<3;i--){
    d+=Math.hypot(tp[i].x-tp[i-1].x,tp[i].y-tp[i-1].y);
    if(out.length===1&&d>=14) out.push(tp[i-1]);
    else if(out.length===2&&d>=28) out.push(tp[i-1]);
  }
  while(out.length<3) out.push(out[out.length-1]);
  return out;
};

// ---------- serveur ----------


const NIVEAUX = { 1:{P:10,re:3,rp:4,phase:4}, 2:{P:9,re:4,rp:5,phase:4},
                  3:{P:9,re:5,rp:6,phase:3}, 4:{P:8,re:5,rp:6,phase:2} };
const RESEAUX = {};
let RESEAU_MANQUANT = false;
function reseau(nom){
  if (RESEAUX[nom]) return RESEAUX[nom];
  if (nom === 'lognes') {
    const f = path.join(__dirname, 'reseau_lognes.json');
    if (fs.existsSync(f)) {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      return (RESEAUX[nom] = new Ville({ data: d }));
    }
    RESEAU_MANQUANT = true;   // dit clairement, jamais en silence
  }
  return (RESEAUX[nom] = new Ville({ graine: 42 }));
}

class Serveur {
  constructor(opts = {}) {
    this.boutique = new Boutique(opts.fichier ?? null);
    this.abonnes = new Map();          // jeton -> {res, joueurId, code, seq}
    this.jetons = new Map();           // jeton -> {code, joueurId}
    this.parties = new Map();          // code -> état de partie vivant
    this.horlogeDecalageMax = 0;
    // les jetons sont persistés : un serveur qui redémarre ne déconnecte personne
    for (const cle of this.boutique.cles('jeton:')) {
      this.jetons.set(cle.slice(6), this.boutique.lire(cle));
    }
    this.http = http.createServer((req, res) => this._router(req, res));
    this.tickTimer = setInterval(() => this._tick(), 1000);
  }
  ecouter(port) { return new Promise(r => this.http.listen(port, () => r(this.http.address().port))); }
  async fermer() {
    clearInterval(this.tickTimer);
    for (const a of this.abonnes.values()) { try { a.res.end(); } catch (e) {} }
    this.abonnes.clear();
    this.boutique.fermer();
    // On coupe les sockets keep-alive : sinon un redémarrage laisse les clients
    // avec des sockets mortes dans leur pool et ils reçoivent un ECONNRESET.
    if (this.http.closeIdleConnections) this.http.closeIdleConnections();
    if (this.http.closeAllConnections) this.http.closeAllConnections();
    await new Promise(r => this.http.close(r));
  }
  _salon(code) { return this.boutique.lire('salon:' + String(code || '').toUpperCase()); }
  _sauver(s) { this.boutique.ecrire('salon:' + s.code, s); return s; }

  // ---------- routage ----------
  async _router(req, res) {
    const u = url.parse(req.url, true);
    const chemin = u.pathname;
    try {
      if (chemin === '/api/temps') return this._json(res, 200, { t: Date.now() });
      if (chemin === '/api/sante') return this._json(res, 200,
        { ok: true, salons: this.boutique.cles('salon:').length, abonnes: this.abonnes.size,
          persistance: this.boutique.fichier ? 'disque' : 'memoire',
          disque_durable: !!process.env.RENDER_DISK,
          reseau_lognes: RESEAU_MANQUANT ? 'absent (ville generee)' : 'charge',
          version: S.VERSION_PROTOCOLE, demarre: DEMARRE });
      if (chemin === '/flux') return this._flux(req, res, u.query);
      if (req.method === 'POST') {
        const corps = await this._corps(req);
        if (chemin === '/api/salon')            return this._creer(res, corps);
        if (chemin === '/api/rejoindre')        return this._rejoindre(res, corps);
        if (chemin === '/api/controle')         return this._controle(res, corps);
        if (chemin === '/api/composer')         return this._composer(res, corps);
        if (chemin === '/api/demarrer')         return this._demarrer(res, corps);
        if (chemin === '/api/positions')        return this._positions(res, corps);
      }
      if (req.method === 'GET' && chemin.startsWith('/api/salon/')) {
        const s = this._salon(chemin.split('/')[3]);
        if (!s) return this._json(res, 404, { ok: false, code: 'salon_inconnu',
          message: 'Ce code de partie n’existe pas. Vérifie les 6 caractères, ou demande un nouveau lien.' });
        return this._json(res, 200, { ok: true, salon: S.vuePublique(s) });
      }
      if (chemin === '/' || chemin.startsWith('/j/')) return this._accueil(res, chemin);
      this._json(res, 404, { ok: false, code: 'route_inconnue', message: 'Adresse inconnue.' });
    } catch (e) {
      // Aucune erreur muette : le client reçoit toujours une phrase.
      this._json(res, 500, { ok: false, code: 'erreur_serveur', message: 'Le serveur a rencontré un problème : ' + e.message });
    }
  }
  _accueil(res, chemin) {
    const code = chemin.startsWith('/j/') ? chemin.slice(3).toUpperCase() : null;
    const s = code ? this._salon(code) : null;
    const corps = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Serveur du jeu de poursuite</title>
<style>body{margin:0;background:#E7EAE6;color:#101820;font:16px/1.5 system-ui,sans-serif;
padding:2.5rem 1.4rem;max-width:34rem;margin:auto}h1{font-size:1.7rem;margin:.2rem 0 1rem}
code{background:#F4F6F2;border:1px solid #C9CFC8;border-radius:3px;padding:.1rem .35rem}
.k{font-size:2.6rem;font-weight:700;letter-spacing:.15em;color:#C4491A;margin:.6rem 0}
@media(prefers-color-scheme:dark){body{background:#0C1014;color:#E4E8E3}code{background:#161C22;border-color:#28323A}}</style>
<h1>Serveur du jeu de poursuite</h1>
${code ? (s ? `<p>La partie <b>${code}</b> existe.</p><div class="k">${code}</div>
<p>Ouvre l'app, choisis « à plusieurs », colle l'adresse de ce serveur et saisis ce code.</p>`
        : `<p>Aucune partie ne porte le code <b>${code}</b>. Vérifie les 6 caractères, ou demande un nouveau lien.</p>`)
      : `<p>Il tourne. Copie l'adresse de cette page dans l'app, à l'écran « Où est le serveur de jeu ? ».</p>
<p><code>${this.boutique.fichier ? 'Salons enregistrés sur disque' : 'Salons en mémoire seulement'}</code>
${RESEAU_MANQUANT ? '<br><code>Carte de Lognes absente — ville d\'entraînement utilisée</code>' : ''}</p>`}
<p style="opacity:.7;font-size:.9rem">État détaillé : <a href="/api/sante">/api/sante</a></p>`;
    const b = Buffer.from(corps);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': b.length });
    res.end(b);
  }
  _json(res, code, obj) {
    const b = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
      'content-length': b.length, 'access-control-allow-origin': '*' });
    res.end(b);
  }
  _corps(req) {
    return new Promise((resoudre, rejeter) => {
      let d = ''; let n = 0;
      req.on('data', c => { n += c.length; if (n > 1e6) { req.destroy(); rejeter(new Error('corps trop gros')); } d += c; });
      req.on('end', () => { try { resoudre(d ? JSON.parse(d) : {}); } catch (e) { resoudre({}); } });
      req.on('error', rejeter);
    });
  }

  // ---------- salon ----------
  _creer(res, c) {
    let code, essais = 0;
    do { code = S.codeSalon(); essais++; } while (this._salon(code) && essais < 50);
    const s = S.creerSalon({ code, terrain: c.terrain, duree_min: c.duree_min,
                             effectif: c.effectif, version: S.VERSION_PROTOCOLE });
    this._sauver(s);
    // Le salon existe AVANT que quiconque n'arrive, et il n'a pas d'hôte
    // technique : il survit au départ de son créateur.
    this._json(res, 200, { ok: true, code, lien: `/j/${code}`, salon: S.vuePublique(s) });
  }
  _rejoindre(res, c) {
    const s = this._salon(c.code);
    if (!s) return this._json(res, 404, { ok: false, code: 'salon_inconnu',
      message: 'Ce code de partie n’existe pas. Vérifie les 6 caractères, ou demande un nouveau lien.' });
    const r = S.rejoindre(s, { joueurId: c.joueurId, nom: c.nom, profil: c.profil,
                               version: c.version ?? S.VERSION_PROTOCOLE });
    if (!r.ok) return this._json(res, 409, r);
    this._sauver(s);
    // Un jeton par (salon, joueur) : rejoindre deux fois donne le MÊME jeton,
    // donc deux téléphones sur le même compte ne se battent pas.
    let jeton = null;
    for (const [j, v] of this.jetons) if (v.code === s.code && v.joueurId === r.joueurId) jeton = j;
    if (!jeton) {
      jeton = crypto.randomBytes(24).toString('hex');
      this.jetons.set(jeton, { code: s.code, joueurId: r.joueurId });
      this.boutique.ecrire('jeton:' + jeton, { code: s.code, joueurId: r.joueurId });
    }
    this._json(res, 200, { ok: true, jeton, joueurId: r.joueurId, retour: r.retour,
      enCours: r.enCours, salon: S.vuePublique(s) });
  }
  _auth(c) {
    const v = this.jetons.get(c.jeton);
    if (!v) return null;
    const s = this._salon(v.code);
    if (!s) return null;
    return { salon: s, joueurId: v.joueurId };
  }
  _controle(res, c) {
    const a = this._auth(c);
    if (!a) return this._json(res, 401, { ok: false, code: 'jeton_invalide',
      message: 'Ta session a expiré. Ressaisis le code de la partie.' });
    for (const [nom, val] of Object.entries(c.controles || {})) S.marquerControle(a.salon, a.joueurId, nom, val);
    this._sauver(a.salon);
    this._json(res, 200, { ok: true, salon: S.vuePublique(a.salon) });
  }
  _composer(res, c) {
    const a = this._auth(c);
    if (!a) return this._json(res, 401, { ok: false, code: 'jeton_invalide', message: 'Ta session a expiré. Ressaisis le code de la partie.' });
    const eq = S.composer(a.salon);
    if (c.valider) a.salon.composition_validee = true;
    this._sauver(a.salon);
    this._json(res, 200, { ok: true, equilibre: eq, salon: S.vuePublique(a.salon) });
  }
  _demarrer(res, c) {
    const a = this._auth(c);
    if (!a) return this._json(res, 401, { ok: false, code: 'jeton_invalide', message: 'Ta session a expiré. Ressaisis le code de la partie.' });
    const s = a.salon;
    if (s.depart) return this._json(res, 200, { ok: true, deja: true, salon: S.vuePublique(s) });
    const p = S.peutDemarrer(s);
    if (!p.ok) return this._json(res, 409, { ok: false, code: 'pas_pret', message: p.message });
    s.depart = Date.now(); s.niveau = c.niveau ?? 3;
    this._sauver(s); this._creerPartie(s);
    this._json(res, 200, { ok: true, depart: s.depart, salon: S.vuePublique(s) });
  }
  _positions(res, c) {
    const a = this._auth(c);
    if (!a) return this._json(res, 401, { ok: false, code: 'jeton_invalide', message: 'Ta session a expiré. Ressaisis le code de la partie.' });
    const s = a.salon;
    s.joueurs[a.joueurId].vuA = Date.now();
    const p = this.parties.get(s.code);
    // Les lots sont HORODATÉS : un tunnel de 60 s ne coûte rien, le client
    // vide son tampon à la reconnexion et le serveur remet tout dans l'ordre.
    const lots = Array.isArray(c.lots) ? c.lots : [];
    let retenus = 0;
    if (p) for (const l of lots.slice(-900)) {   // 15 min de tampon à 1 Hz
      if (typeof l.t !== 'number') continue;
      // Sans capteur, on retient la cadence CIBLE : la poursuite avance au
      // tempo prescrit plutôt qu'à une valeur par défaut inventée. Le drapeau
      // dit laquelle des deux a servi.
      const c = (l.cadence != null) ? l.cadence : (l.cible ?? null);
      p.entrees.push({ joueurId: a.joueurId, t: l.t, cadence: c,
                       mesuree: l.cadence != null,
                       pas: l.pas ?? 0, precision: l.precision ?? null, cap: l.cap ?? null });
      retenus++;
    }
    this._sauver(s);
    // On renvoie l'heure SERVEUR : le client cale son décalage dessus et
    // n'utilise jamais l'horloge du téléphone pour les fenêtres.
    this._json(res, 200, { ok: true, retenus, t_serveur: Date.now(),
      t_client: c.t_client ?? null });
  }

  // ---------- flux SSE, filtré PAR DESTINATAIRE ----------
  _flux(req, res, q) {
    const v = this.jetons.get(q.jeton);
    if (!v) { res.writeHead(401, { 'content-type': 'text/plain' });
      return res.end('Session expirée — ressaisis le code de la partie.'); }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform', connection: 'keep-alive',
      'x-accel-buffering': 'no', 'access-control-allow-origin': '*' });
    res.write('retry: 2000\n\n');                   // le navigateur reconnecte seul
    const abonne = { res, joueurId: v.joueurId, code: v.code, seq: 0 };
    this.abonnes.set(q.jeton, abonne);
    req.on('close', () => { if (this.abonnes.get(q.jeton) === abonne) this.abonnes.delete(q.jeton); });
    this._envoyer(q.jeton, abonne);                 // instantané immédiat
  }
  _creerPartie(s) {
    const niv = NIVEAUX[s.niveau ?? 3];
    const p = new Partie({ ville: reseau(s.terrain), duree_min: s.duree_min, niv, G0: 200 });
    const e = { p, niv, entrees: [], derniereCadence: {}, tDernier: Date.now() };
    this.parties.set(s.code, e);
    return e;                       // l'ENTRÉE, pas la Partie : le tick en a besoin
  }
  _tick() {
    const maintenant = Date.now();
    for (const code of this.boutique.cles('salon:').map(k => k.slice(6))) {
      try { this._tickSalon(code, maintenant); }
      catch (err) {
        // Un salon en vrac ne fait pas tomber les autres parties.
        const e = this.parties.get(code);
        if (e) e.derniereErreur = String(err && err.message);
      }
    }
    for (const [jeton, a] of this.abonnes) {
      try { this._envoyer(jeton, a); } catch (err) { this.abonnes.delete(jeton); }
    }
  }
  _tickSalon(code, maintenant) {
    {
      const s = this._salon(code); if (!s) return;
      if (s.depart && !s.finie) {
        let e = this.parties.get(code);
        if (!e) {
          // Reprise après redémarrage : on replace la partie où elle en était.
          e = this._creerPartie(s);
          e.p.t = Math.min((maintenant - s.depart) / 1000, s.duree_min * 60);
        }
        const dt = Math.min(3, (maintenant - e.tDernier) / 1000); e.tDernier = maintenant;
        for (const en of e.entrees) if (en.cadence != null) e.derniereCadence[en.joueurId] = en.cadence;
        e.entrees.length = 0;
        const cad = Object.values(e.derniereCadence);
        const moy = cad.length ? cad.reduce((a, b) => a + b, 0) / cad.length : 170;
        const f = fenetre(e.niv, e.p.roleJoueur, e.p.t), g = fenetre(e.niv, e.p.roleJoueur === 'fuite' ? 'chasse' : 'fuite', e.p.t);
        try { e.p.tick(dt, moy, f.enCourse, g.enCourse); } catch (err) { e.derniereErreur = String(err && err.message); }
        if (e.p.finie) { s.finie = true; this._sauver(s); }
      }
    }
  }
  // La règle inviolable : la position adverse ne quitte JAMAIS le serveur en
  // clair. Le filtrage se fait ici, avant émission, destinataire par destinataire.
  _envoyer(jeton, a) {
    const s = this._salon(a.code); if (!s) return;
    const e = this.parties.get(a.code);
    const paquet = { t: Date.now(), salon: S.vuePublique(s) };
    if (e && s.depart && !s.finie) {
      const moi = s.joueurs[a.joueurId];
      const jeSuis = (moi && moi.camp === 1) ? 'chasse' : 'fuite';
      const f = fenetre(e.niv, jeSuis, e.p.t);
      const vue = e.p.vueAdverse();
      paquet.partie = {
        t: Math.round(e.p.t), duree: e.p.duree, role: jeSuis,
        fenetre: { enCourse: f.enCourse, restant: Math.round(f.restant) },
        acte: e.p.acte(), rayonZone: Math.round(e.p.rayonZone()),
        captures: e.p.captures, echappes: e.p.echappes,
        // ma patrouille : en clair
        moi: { x: Math.round(e.p.joueur.x), y: Math.round(e.p.joueur.y) },
        // adverse : ce que l'acte autorise, et RIEN de plus
        adverse: vue.mode === 'exact' ? { mode: 'exact', x: Math.round(vue.x), y: Math.round(vue.y) }
               : vue.mode === 'halo'  ? { mode: 'halo', x: Math.round(vue.x), y: Math.round(vue.y), rayon: Math.round(vue.rayon) }
               : { mode: 'ping', x: Math.round(vue.x), y: Math.round(vue.y), age: Math.round(vue.age || 0) },
      };
      if (e.derniereErreur) paquet.partie.avertissement = 'Pépin côté serveur : ' + e.derniereErreur;
    }
    try { a.res.write(`id: ${++a.seq}\ndata: ${JSON.stringify(paquet)}\n\n`); }
    catch (err) { this.abonnes.delete(jeton); }
  }
}
function fenetre(niv, role, t) {
  const P = niv.P * 60, d = (role === 'chasse' ? niv.rp : niv.re) * 60,
        dec = (role === 'chasse' ? niv.phase * 60 : 0);
  const u = ((t - dec) % P + P) % P, c = u < d;
  return { enCourse: c, restant: c ? d - u : P - u };
}


// ---------- démarrage ----------
const DEMARRE = new Date().toISOString();
if (require.main === module) {
  const dossier = process.env.DONNEES || (process.env.RENDER_DISK ? process.env.RENDER_DISK + '/journal.jsonl' : './donnees/journal.jsonl');
  const s = new Serveur({ fichier: dossier });
  const port = Number(process.env.PORT) || 10000;
  // Render exige 0.0.0.0 : sinon le port n'est pas détecté et le déploiement échoue.
  s.http.listen(port, '0.0.0.0', () => {
    console.log('Serveur du jeu de poursuite — écoute sur 0.0.0.0:' + port);
    console.log('Salons  : ' + dossier);
    if (!process.env.RENDER_DISK)
      console.log('ATTENTION : aucun disque persistant (RENDER_DISK non défini).');
    console.log('Carte   : ' + (fs.existsSync(require('node:path').join(__dirname,'reseau_lognes.json'))
      ? 'reseau_lognes.json chargé' : 'reseau_lognes.json ABSENT — ville d\'entraînement'));
  });
}
module.exports = { Serveur, fenetre };

