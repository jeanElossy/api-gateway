"use strict";

/**
 * ============================================================================
 * LA PASSERELLE EST UN BORD — ELLE NE POSSÈDE AUCUN DOMAINE
 * ============================================================================
 *
 * ── Ce que ce test verrouille, et pourquoi ──────────────────────────────────
 *
 * Une passerelle fait cinq choses : terminaison TLS et routage, VÉRIFICATION
 * d'un jeton, limitation de débit, validation de forme et corrélation,
 * observabilité. Elle ne décide d'aucun prix, n'évalue aucun risque métier, ne
 * possède aucun domaine et ne détient aucune base.
 *
 * C'est la structure de Stripe, PayPal et Adyen, et la raison n'est pas
 * esthétique : le bord est la surface la plus exposée d'Internet. Une base à
 * cet endroit place les règles tarifaires et les données utilisateur derrière
 * la seule porte que le monde entier peut frapper.
 *
 * Le corollaire compte davantage encore : **LES DÉPENDANCES DESCENDENT.**
 * Bord → services → moteur. Jamais l'inverse.
 *
 * ── L'état trouvé le 2026-09-10 ─────────────────────────────────────────────
 *
 * · 13 modèles Mongoose et 2 connexions dans la passerelle ;
 * · le domaine des prix lui appartenait — et **Tx-Core, le moteur d'argent,
 *   venait y chercher ses devis en HTTP**. Tx-Core l'annonçait lui-même au
 *   démarrage : « GATEWAY_URL absente ⇒ toute transaction nécessitant un devis
 *   échouera en 503 ». Une panne du bord arrêtait les virements de l'intérieur
 *   du moteur, et le bord ne pouvait plus être redéployé seul ;
 * · un `User.findById()` sur la base de la passerelle à CHAQUE requête
 *   authentifiée, dupliquant un contrôle que le backend principal fait déjà.
 *
 * Tests **purs** : lecture de fichiers et fonctions pures. Aucune connexion,
 * aucun serveur.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const RACINE = path.resolve(__dirname, "..", "..");

function lire(...s) {
  return fs.readFileSync(path.join(RACINE, ...s), "utf8");
}

function sansCommentaires(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Parcourt le code applicatif de la passerelle, hors tests et node_modules. */
function fichiersSource() {
  const out = [];
  const pile = ["src", "controllers", "routes"]
    .map((d) => path.join(RACINE, d))
    .filter((d) => fs.existsSync(d));

  while (pile.length) {
    const courant = pile.pop();

    if (fs.statSync(courant).isDirectory()) {
      for (const e of fs.readdirSync(courant, { withFileTypes: true })) {
        if (e.name === "node_modules") continue;
        pile.push(path.join(courant, e.name));
      }
    } else if (courant.endsWith(".js")) {
      out.push(courant);
    }
  }

  return out;
}

function fichiersContenant(motif, { sauf = [] } = {}) {
  return fichiersSource()
    .filter((f) => motif.test(sansCommentaires(fs.readFileSync(f, "utf8"))))
    .map((f) => path.relative(RACINE, f))
    .filter((f) => !sauf.includes(f))
    .sort();
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 1. LA DÉPENDANCE NE REMONTE PLUS                                          */
/* ══════════════════════════════════════════════════════════════════════════ */

test("Tx-Core n'appelle plus la passerelle pour ses devis", () => {
  const pont = path.resolve(
    RACINE,
    "..",
    "..",
    "api-paynoval",
    "src",
    "services",
    "transactions",
    "shared",
    "pricing.js"
  );

  if (!fs.existsSync(pont)) return; // dépôt voisin absent : on ne bloque pas.

  const src = sansCommentaires(fs.readFileSync(pont, "utf8"));

  /**
   * ⚠️ C'EST L'ASSERTION CENTRALE DE TOUT CE FICHIER.
   *
   * Tant que ce module postait sur `${GATEWAY_URL}/pricing/quote`, le moteur
   * d'argent dépendait du bord : une panne de la passerelle arrêtait les
   * virements de l'intérieur, et le bord était indéployable seul.
   */
  assert.ok(
    !src.includes("GATEWAY_URL"),
    "Tx-Core ne doit plus connaître l'URL de la passerelle pour tarifer"
  );
  assert.ok(
    !/axios\.(post|get)\(/.test(src),
    "le devis doit être un appel de fonction, pas un appel réseau"
  );
  assert.match(
    src,
    /require\("\.\.\/\.\.\/pricing\/quoteService"\)/,
    "le devis se calcule dans le processus"
  );
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* 2. LE BORD NE POSSÈDE PLUS LE DOMAINE DES PRIX                            */
/* ══════════════════════════════════════════════════════════════════════════ */

test("aucune route de tarification ne sert un handler natif", () => {
  for (const [fichier, cible] of [
    ["routes/pricingRoutes.js", "pricingController"],
    ["routes/fees.js", "/api/v1/fees"],
    ["routes/fxRules.js", "/api/v1/fx-rules"],
    ["routes/pricingRulesRoutes.js", "/api/v1/pricing-rules"],
    ["routes/pricingChangeRequestsRoutes.js", "/api/v1/pricing-change-requests"],
    ["routes/admin/exchangeRates.routes.js", "/api/v1/exchange-rates"],
  ]) {
    const src = sansCommentaires(lire(fichier));

    if (fichier === "routes/pricingRoutes.js") {
      /** Ce fichier passe par le contrôleur, qui est lui-même un relais. */
      assert.ok(src.includes(cible), `${fichier} doit servir ${cible}`);
      continue;
    }

    assert.ok(
      src.includes("relayerVers"),
      `${fichier} doit RELAYER, pas servir un contrôleur natif`
    );
    assert.ok(src.includes(cible), `${fichier} doit viser ${cible}`);
  }
});

test("le contrôleur de tarification relaie et ne calcule plus", () => {
  const src = sansCommentaires(lire("controllers", "pricingController.js"));

  assert.match(src, /\/api\/v1\/pricing\/quote/);

  for (const interdit of [
    "computeQuote",
    "getActiveRules",
    "getExchangeRate",
    "PricingQuote",
    "roundMoney",
  ]) {
    assert.ok(
      !src.includes(interdit),
      `la passerelle ne doit plus calculer : « ${interdit} » a été trouvé`
    );
  }
});

test("un relais ne réinterprète JAMAIS la réponse", () => {
  /**
   * Un 404 « aucun barème ne couvre ce corridor » et un 503 « taux
   * indisponible » portent chacun une information que l'appelant doit recevoir
   * telle quelle. Les fondre en 502 perd le diagnostic ; les transformer en 200
   * avec une valeur par défaut ferait accepter une opération à un tarif que
   * personne n'a décidé (règle B.2).
   */
  const relais = sansCommentaires(lire("src", "services", "txCoreRelay.js"));

  assert.match(relais, /res\.status\(reponse\.status\)\.json\(reponse\.data\)/);
  assert.match(relais, /validateStatus:\s*\(\)\s*=>\s*true/);
});

test("le relais ne transmet ni le jeton du client ni une identité déclarative", () => {
  const { EN_TETES_ECARTES } = require("../../src/services/txCoreRelay");

  /**
   * `authorization` doit être écarté : le transmettre laisserait Tx-Core croire
   * qu'il parle au client. `x-user-id` et `x-user-role` doivent l'être aussi —
   * ils sont RÉÉMIS par le relais à partir de l'identité qu'il a lui-même
   * établie. Les laisser passer permettrait à un client de se déclarer admin.
   */
  for (const attendu of [
    "authorization",
    "x-internal-token",
    "x-user-id",
    "x-user-role",
    "host",
    "content-length",
  ]) {
    assert.ok(
      EN_TETES_ECARTES.includes(attendu),
      `« ${attendu} » doit être écarté du relais`
    );
  }
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* 3. L'AUTHENTIFICATION NE LIT PLUS LA BASE                                 */
/* ══════════════════════════════════════════════════════════════════════════ */

test("le middleware d'authentification n'ouvre aucune connexion Mongo", () => {
  const src = sansCommentaires(lire("src", "middlewares", "auth.js"));

  for (const interdit of ["getUsersConnection", "getUserModel", "findById"]) {
    assert.ok(
      !src.includes(interdit),
      `l'authentification du bord ne doit pas lire la base (« ${interdit} »)`
    );
  }

  assert.match(src, /estRevoque\(/, "la révocation remplace la lecture");
  assert.match(src, /__source:\s*"jwt-claims"/);
});

test("PLUS AUCUN chemin du bord ne lit un document de la base utilisateurs", () => {
  /**
   * ⚠️ CE TEST A CHANGÉ DE NATURE LE 2026-09-10, ET C'EST L'ÉVÉNEMENT.
   *
   * Il exigeait auparavant que l'exception reste UNIQUE et NOMMÉE :
   * `middlewares/aml.js` avait besoin de treize champs de conformité que le
   * jeton ne porte pas. Le commentaire de cette liste disait déjà « part avec
   * l'AML » — c'est fait.
   *
   * L'AML unique vit dans Tx-Core, où le profil se recharge de toute façon
   * (`requireTransactionEligibility.findFreshUser`). La passerelle faisait donc
   * une lecture que le moteur REFAISAIT quelques millisecondes plus tard, sur
   * le même document, dans la même requête.
   *
   * Il ne reste que `src/app.js`, qui lit l'ÉTAT de la connexion pour `/health`
   * et n'ouvre aucun document. Toute nouvelle entrée dans cette liste est une
   * reconquête du bord par un domaine : elle doit être discutée, pas glissée.
   */
  const lecteurs = fichiersContenant(/getUsersConnection|models\/userModel/, {
    sauf: [],
  });

  assert.deepEqual(
    lecteurs,
    [],
    "un chemin du bord lit de nouveau la base des utilisateurs : " +
      lecteurs.join(", ")
  );

  const demarrage = sansCommentaires(lire("src", "server.js"));

  assert.ok(
    !demarrage.includes("connectToUsersDB"),
    "src/server.js rouvre la connexion à la base des utilisateurs"
  );

  assert.ok(
    !fs.existsSync(path.join(RACINE, "src", "models", "userModel.js")),
    "le modèle utilisateur est revenu au bord"
  );
});

/**
 * ============================================================================
 * LE BORD N'OUVRE PLUS AUCUNE BASE — 2026-09-10
 * ============================================================================
 *
 * L'invariant précédent — « le bord ne lit plus la base des utilisateurs » —
 * est devenu un cas particulier de celui-ci.
 *
 * Mesure qui a précédé le retrait, sur l'ensemble du dépôt hors scripts et
 * tests : 0 modèle déclaré, 0 collection nommée, 0 requête émise. La passerelle
 * ouvrait pourtant `MONGO_URI_GATEWAY` à chaque démarrage.
 *
 * Ce que cette connexion coûtait, elle qui ne servait plus :
 *
 *   · `process.exit(1)` si la base était injoignable — une panne Atlas sur une
 *     base que personne ne lit empêchait le bord de DÉMARRER ;
 *   · `readiness required: ["main"]` l'écartait de la rotation ;
 *   · huit préfixes de routes, tous devenus de purs relais vers Tx-Core,
 *     refusaient en 500 tant que `readyState !== 1`. La tarification tombait à
 *     cause d'une base qu'elle n'interroge pas.
 *
 * ── La PAIRE, sans laquelle un déplacement n'est pas prouvé ─────────────────
 *
 * Absence à l'origine (aucun ouvreur de connexion) ET absence du fichier qui
 * la portait. Vérifier seulement la première laisserait revenir un `db.js`
 * dormant, qu'un seul `require` suffirait à réveiller.
 */
test("le bord n'ouvre AUCUNE connexion à une base", () => {
  const OUVERTURE =
    /require\(\s*["']mongoose["']\s*\)|mongoose\.connect|createConnection|new\s+MongoClient/;

  const fautifs = [];

  for (const f of fichiersSource()) {
    const code = sansCommentaires(fs.readFileSync(f, "utf8"));
    if (OUVERTURE.test(code)) fautifs.push(path.relative(RACINE, f));
  }

  assert.deepEqual(
    fautifs,
    [],
    "un chemin du bord ouvre de nouveau une base : " + fautifs.join(", ")
  );

  assert.ok(
    !fs.existsSync(path.join(RACINE, "src", "db.js")),
    "src/db.js est revenu — il ne portait plus qu'une connexion que personne " +
      "ne lisait, et un fichier dormant se réveille d'un seul require"
  );
});

test("le détecteur d'ouverture de base MORD", () => {
  /* Un garde-fou muet passe toujours : on le vérifie sur les quatre formes. */
  const OUVERTURE =
    /require\(\s*["']mongoose["']\s*\)|mongoose\.connect|createConnection|new\s+MongoClient/;

  for (const forme of [
    'const m = require("mongoose");',
    "await mongoose.connect(uri);",
    "const c = mongoose.createConnection(uri);",
    "const cli = new MongoClient(uri);",
  ]) {
    assert.ok(OUVERTURE.test(forme), forme);
  }

  /* ...et il laisse passer l'histoire écrite en commentaire. */
  assert.ok(
    !OUVERTURE.test(
      sansCommentaires('/* elle appelait mongoose.connect(uri) avant */')
    )
  );
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* 4. LA RÉVOCATION : POSTURE EXPLICITE EN CAS DE PANNE                      */
/* ══════════════════════════════════════════════════════════════════════════ */

test("un rôle à privilèges échoue en FERMETURE si la révocation est illisible", async () => {
  const { estRevoque, ROLES_SENSIBLES } = require("../../src/services/tokenRevocation");

  for (const role of ROLES_SENSIBLES) {
    const r = await estRevoque({
      userId: "507f1f77bcf86cd799439011",
      issuedAtSeconds: Math.floor(Date.now() / 1000),
      role,
    });

    /**
     * Redis n'est pas configuré dans les tests : c'est exactement le cas
     * « état de révocation illisible ». Un compte à privilèges doit être
     * refusé — leur nombre est faible, leur rayon d'impact ne l'est pas.
     */
    assert.equal(r.revoked, true, `le rôle ${role} doit échouer en fermeture`);
    assert.equal(r.reason, "REVOCATION_STORE_UNAVAILABLE");
  }
});

test("un utilisateur ordinaire n'est pas bloqué par une panne de cache", async () => {
  const { estRevoque } = require("../../src/services/tokenRevocation");

  /**
   * Échouer en fermeture pour tous transformerait une panne de cache en panne
   * d'authentification totale. Le filet reste la durée de vie du jeton — et
   * surtout, les chemins qui déplacent de l'argent sont RELAYÉS vers des
   * services qui relisent l'utilisateur en base.
   */
  const r = await estRevoque({
    userId: "507f1f77bcf86cd799439011",
    issuedAtSeconds: Math.floor(Date.now() / 1000),
    role: "user",
  });

  assert.equal(r.revoked, false);
});

test("un sujet absent est refusé", async () => {
  const { estRevoque } = require("../../src/services/tokenRevocation");

  const r = await estRevoque({ userId: "", issuedAtSeconds: 1, role: "user" });

  assert.equal(r.revoked, true);
  assert.equal(r.reason, "NO_SUBJECT");
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* 5. AUCUNE MÉTRIQUE NE MENT SUR UNE CAPACITÉ ABSENTE                       */
/* ══════════════════════════════════════════════════════════════════════════ */

test("la passerelle n'annonce plus un cache applicatif qu'elle n'a plus", () => {
  const src = sansCommentaires(lire("src", "app.js"));

  /**
   * La sonde publiait les statistiques du cache des règles de change, parti
   * avec la tarification. La laisser aurait produit le défaut R-08 : une jauge
   * qui rapporte zéro parce que la source n'existe plus, lue comme « cache
   * sain » (règles B.6 et B.7).
   */
  assert.ok(!src.includes("fxRulesService"));
  assert.match(src, /appCacheStats:\s*\(\)\s*=>\s*\(\{\s*contourne:\s*true\s*\}\)/);
});
