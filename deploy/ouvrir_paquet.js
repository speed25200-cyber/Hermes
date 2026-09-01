#!/usr/bin/env node
// Ouvre sur le VPS un paquet chiffre arrive par un workflow.
//
// Pourquoi ce detour. Les cles doivent traverser un runner GitHub pour
// atteindre la machine, et la seule voie disponible est une entree de
// workflow_dispatch — que la page du run AFFICHE. Ce depot est public.
// Une cle passee en entree serait donc lisible par n'importe qui, et
// c'est exactement l'accident deja survenu une fois sur ce depot.
//
// Le paquet voyage donc chiffre. La cle de chiffrement n'est jamais
// transmise : elle est derivee de HERMES_DASH_TOKEN, qui vit dans le
// .env de la machine et n'a jamais ete ecrit ni dans le depot, ni dans
// un journal, ni dans une entree de workflow. Le runner porte un bloc
// qu'il ne peut pas lire, et c'est tout ce qu'on lui demande.
//
// Entree : le paquet en base64, sur l'entree standard.
// Sortie : le texte en clair, sur la sortie standard, destine a etre
//          redirige vers poser_cles.sh — jamais ecrit sur le disque.
"use strict";
const crypto = require("crypto");
const fs = require("fs");

function jeton() {
  // On lit le .env a la main plutot que par dotenv : ce script doit
  // pouvoir tourner avant meme que les dependances soient installees.
  let texte = "";
  const ou = process.env.HERMES_ENV_FILE || "/root/hermes/.env";
  try { texte = fs.readFileSync(ou, "utf8"); } catch {}
  const m = texte.match(/^[ \t]*HERMES_DASH_TOKEN[ \t]*=[ \t]*(.*)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

const t = jeton();
if (!t) {
  console.error("!! HERMES_DASH_TOKEN introuvable dans /root/hermes/.env :");
  console.error("   sans lui le paquet ne peut pas etre ouvert. Lancer d'abord");
  console.error("   un deploiement, qui cree ce jeton s'il manque.");
  process.exit(1);
}

let brut = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { brut += c; });
process.stdin.on("end", () => {
  const paquet = Buffer.from(brut.replace(/\s+/g, ""), "base64");
  if (paquet.length < 29) {
    console.error("!! paquet trop court pour etre valide");
    process.exit(1);
  }
  const cle   = crypto.createHash("sha256").update(t, "utf8").digest();
  const nonce = paquet.subarray(0, 12);
  const tag   = paquet.subarray(12, 28);
  const corps = paquet.subarray(28);
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", cle, nonce);
    d.setAuthTag(tag);
    // GCM authentifie : si le jeton n'est pas le bon, ou si un octet a
    // ete modifie en route, final() jette. On ne peut donc pas ecrire
    // un dechiffrement approximatif — c'est tout ou rien, et c'est la
    // propriete qu'on veut ici.
    process.stdout.write(Buffer.concat([d.update(corps), d.final()]));
  } catch {
    console.error("!! le paquet ne s'ouvre pas : le jeton de cette machine");
    console.error("   ne correspond pas a celui qui a servi a le fermer,");
    console.error("   ou le paquet a ete altere en route. Rien n'est ecrit.");
    process.exit(1);
  }
});
