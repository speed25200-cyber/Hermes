/* ============================================================================
   Le client Jev — un appel HTTP, rien de plus.

   TypeSafe publie un SDK JavaScript (@ai-sdk/typesafe-ai), qui tire `ai` et
   sa chaine de dependances ESM. Hermes est en CommonJS et n'a besoin que
   d'un POST : le SDK couterait plus de surface qu'il n'en economise. Le
   patron suivi ici est celui du client de jev-review (endpoint, en-tetes,
   codes rejouables), reduit a ce dont ce depot se sert.

   Jev ne predit pas une serie : il JUGE un etat. Tout ce qui entre ici est
   donc un objet lisible — un etat du monde a un instant — et tout ce qui en
   sort est une reponse typee avec sa probabilite. Ce que cette probabilite
   vaut sur NOS donnees n'est pas garanti par le fournisseur : c'est au banc
   de le mesurer, comme pour n'importe quel signal.

   Deux regles de surete, et elles ne sont pas negociables :

   1. Aucun appel sur le chemin d'une SORTIE de position. Une API distante
      qui met une seconde a repondre, ou qui ne repond pas, ne doit jamais
      pouvoir retarder la fermeture d'une position a levier.
   2. Jev injoignable = le moteur se comporte exactement comme sans Jev.
      Toute fonction appelante doit traiter `null` comme « pas d'avis », pas
      comme un refus ni comme un accord.
   ============================================================================ */
"use strict";

const ENDPOINT = process.env.JEV_ENDPOINT || "https://api.typesafe.ai/v1/systemone";
const MODELE = process.env.JEV_MODEL || "jev-latest";

/* Le plafond d'entree n'est pas publie par TypeSafe ; jev-review l'a releve
   empiriquement autour de 32 768 tokens sur jev-latest. On ne tronque pas a
   l'aveugle : un etat trop gros est une erreur d'appelant, qui doit reduire
   son contexte lui-meme. */
const ERREURS = {
  401: "cle refusee (TYPESAFE_AI_API_KEY absente ou perimee)",
  422: "etat ou questions refuses par Jev",
  429: "limite de debit",
  529: "service surcharge",
};

function rejouable(statut) {
  return statut === 429 || statut === 529 || statut >= 500;
}

/* Le delai avant reessai : ce que dit `retry-after` s'il le dit, sinon un
   recul exponentiel. Plafonne, parce qu'un appelant qui attend trente
   secondes de plus n'a plus rien a juger d'utile. */
function delaiReessai(entete, essai) {
  const annonce = Number(entete);
  if (Number.isFinite(annonce) && annonce > 0) return Math.min(annonce * 1000, 5000);
  return Math.min(250 * Math.pow(2, essai), 4000);
}

/* Interroge Jev.

     etat       objet JSON, nomme par champs — la doc TypeSafe recommande des
                champs nommes des que le contexte a plusieurs parties.
     questions  { identifiant: { type, instructions, criteria? } }, ou type
                vaut "choice", "score" ou "noul". Les questions INDEPENDANTES
                sur le meme etat partent ENSEMBLE : elles sont evaluees en
                parallele et ne se voient pas l'une l'autre. Deux appels ne
                se justifient que si la reponse du premier change l'etat du
                second.

   Rend la reponse brute de l'API, ou leve. L'appelant decide quoi faire d'un
   echec ; ce module ne choisit pas a sa place. */
async function interroger(etat, questions, options) {
  const o = options || {};
  const cle = (o.cle || process.env.TYPESAFE_AI_API_KEY || process.env.JEV_API_KEY || "").trim();
  if (!cle) throw new Error("jev: TYPESAFE_AI_API_KEY absente");

  const delaiMax = o.delaiMs || 10000;
  const essaisMax = o.essais == null ? 2 : o.essais;

  let derniere = null;
  for (let essai = 0; essai <= essaisMax; essai++) {
    const arret = new AbortController();
    const minuteur = setTimeout(() => arret.abort(), delaiMax);
    try {
      const r = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${cle}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: o.modele || MODELE, state: etat, questions }),
        signal: arret.signal,
      });
      if (r.ok) return await r.json();

      /* Le corps porte parfois `detail.error_type` : `max_tokens_exceeded`
         veut dire « etat trop gros », et le repeter a l'identique ne le
         rendra pas plus petit. */
      let type = null;
      try { const b = await r.json(); type = b && b.detail && b.detail.error_type || null; } catch {}
      if (r.status === 400 && type === "max_tokens_exceeded") {
        throw new Error("jev: etat trop gros (max_tokens_exceeded) — reduire le contexte");
      }
      derniere = new Error(`jev: HTTP ${r.status}${ERREURS[r.status] ? " — " + ERREURS[r.status] : ""}`);
      if (!rejouable(r.status) || essai === essaisMax) throw derniere;
      await new Promise((res) => setTimeout(res, delaiReessai(r.headers.get("retry-after"), essai)));
    } catch (e) {
      if (e && e.name === "AbortError") {
        derniere = new Error(`jev: pas de reponse en ${delaiMax} ms`);
        if (essai === essaisMax) throw derniere;
        continue;
      }
      throw e;
    } finally {
      clearTimeout(minuteur);
    }
  }
  throw derniere || new Error("jev: echec apres reessais");
}

/* La version qui ne leve jamais. C'est celle que le moteur vivant doit
   utiliser : un avis manquant est un avis manquant, pas un incident.
   Le motif est rendu pour que le journal puisse le nommer — un refus
   silencieux est exactement le defaut releve par l'audit du 29 aout, ou
   l'interface annoncait « Connecte OKX » sur un flux mort. */
async function interrogerOuNull(etat, questions, options) {
  try {
    return { ok: true, reponse: await interroger(etat, questions, options) };
  } catch (e) {
    return { ok: false, reponse: null, motif: e && e.message ? e.message : String(e) };
  }
}

/* Lecture d'une reponse Noul : la probabilite de « oui ».

   Piege signale par la doc TypeSafe, et il compte ici plus qu'ailleurs : un
   Noul a 0,5 signifie « autant oui que non », PAS « moyennement intense ».
   Un code qui dimensionne une position proportionnellement a cette valeur
   traiterait une hesitation comme une demi-conviction. Le seuil appartient
   a l'appelant, mesure sur ses propres donnees. */
function probaNoul(reponse, id) {
  const a = reponse && reponse.answers && reponse.answers[id];
  if (!a) return null;
  if (typeof a.probability === "number") return a.probability;
  if (a.probabilities && typeof a.probabilities.true === "number") return a.probabilities.true;
  if (typeof a.choice === "boolean") return a.choice ? 1 : 0;
  return null;
}

/* Lecture d'une reponse Choice : l'option retenue, et sa distribution.

   La « confiance » rendue par l'API resume la CONCENTRATION de cette
   distribution — pas la justesse de la reponse, et surtout pas une
   autorisation d'agir. Elle est exposee telle quelle, sans etre melangee
   a la probabilite. */
function choix(reponse, id) {
  const a = reponse && reponse.answers && reponse.answers[id];
  if (!a) return null;
  const confiances = reponse.providerMetadata && reponse.providerMetadata.typesafe
    && reponse.providerMetadata.typesafe.confidence;
  return {
    option: a.choice == null ? null : a.choice,
    probabilites: a.probabilities || null,
    confiance: confiances && typeof confiances[id] === "number" ? confiances[id] : null,
  };
}

module.exports = { interroger, interrogerOuNull, probaNoul, choix, ENDPOINT, MODELE };
