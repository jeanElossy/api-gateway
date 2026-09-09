"use strict";

/**
 * UN SECRET D'AUTORISATION NE S'ÉCRIT PAS DANS UNE REQUÊTE ENTRANTE
 * ============================================================================
 *
 * `src/middlewares/auditHeaders.js` posait, sans condition et pour TOUTE
 * requête traversant la passerelle :
 *
 *     req.headers['x-internal-token'] = config.internalToken || '';
 *
 * Les routes NATIVES montées après lui relisaient cet en-tête comme s'il venait
 * de l'appelant. La barrière d'authentification étant en mode observation
 * (`AUTH_BARRIER_STRICT=false`), une requête sans aucun identifiant arrivait
 * jusque-là avec un jeton interne parfaitement valide.
 *
 * Conséquence mesurée le 2026-09-03 : `POST`, `PUT`, `PATCH` et `DELETE` sur
 * `/api/v1/fx-rules` et `/api/v1/fees` s'exécutaient **sans authentification**.
 * Les règles de change et les barèmes de frais — la frontière de tarification.
 *
 * Ces tests échouent si l'injection revient, dans ce middleware ou dans un
 * autre. La distinction qu'ils protègent : ce que l'APPELANT a présenté ne se
 * confond jamais avec ce que NOUS ajoutons pour l'aval. Un en-tête destiné à un
 * service en aval se pose sur la requête SORTANTE (`proxyReq.setHeader`), là où
 * le proxy le fait déjà — `src/app.js:843-846` et `:928-932`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const RACINE = path.join(__dirname, "..", "..");

/** On teste le code, pas ce qu'on en dit : commentaires retirés. */
function sansCommentaires(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function fichiersJs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;

  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...fichiersJs(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

/**
 * Écriture dans les en-têtes ENTRANTS : `req.headers[...] = ...`.
 * `proxyReq.setHeader(...)` — la requête SORTANTE — est légitime et ignoré.
 */
const ECRITURE_ENTRANTE =
  /req\s*\.\s*headers\s*\[\s*["'`]x-internal-token["'`]\s*\]\s*=/i;

test("auditHeaders n'écrit plus x-internal-token dans la requête entrante", () => {
  const src = sansCommentaires(
    fs.readFileSync(
      path.join(RACINE, "src/middlewares/auditHeaders.js"),
      "utf8"
    )
  );

  assert.equal(
    ECRITURE_ENTRANTE.test(src),
    false,
    "auditHeaders fabrique de nouveau un jeton interne valide : toute route " +
      "native montée après lui devient accessible sans authentification."
  );
});

test("aucun middleware n'écrit x-internal-token dans req.headers", () => {
  const coupables = fichiersJs(path.join(RACINE, "src/middlewares"))
    .filter((p) => ECRITURE_ENTRANTE.test(sansCommentaires(fs.readFileSync(p, "utf8"))))
    .map((p) => path.relative(RACINE, p));

  assert.deepEqual(
    coupables,
    [],
    `Ces middlewares écrivent x-internal-token dans la requête ENTRANTE : ` +
      `${coupables.join(", ")}. Un jeton destiné à l'aval se pose sur la ` +
      `requête SORTANTE (proxyReq.setHeader), jamais sur celle qu'on est en ` +
      `train d'autoriser.`
  );
});

test("le proxy, LUI, pose bien le jeton sur la requête sortante", () => {
  const src = fs.readFileSync(path.join(RACINE, "src/app.js"), "utf8");

  assert.match(
    src,
    /proxyReq\.setHeader\(\s*\n?\s*["']x-internal-token["']/,
    "Le proxy ne pose plus le jeton sortant : les appels vers le backend " +
      "principal partiraient sans x-internal-token."
  );
});

/**
 * Les deux routes qui ont réellement été exposées. Leur `requireInternalOrAdmin`
 * n'est sûr que tant que `x-internal-token` reflète ce que l'appelant a envoyé.
 */
test("fx-rules et fees gardent leur contrôle d'accès", () => {
  for (const rel of ["routes/fxRules.js", "routes/fees.js"]) {
    const src = sansCommentaires(fs.readFileSync(path.join(RACINE, rel), "utf8"));

    assert.match(
      src,
      /router\.use\(\s*requireInternalOrAdmin\s*\)/,
      `${rel} : le contrôle d'accès a disparu du routeur.`
    );
    assert.match(
      src,
      /secureCompare\(/,
      `${rel} : la comparaison du jeton doit rester en temps constant.`
    );
    assert.match(
      src,
      /requireAdmin\(req,\s*res,\s*next\)/,
      `${rel} : le repli vers requireAdmin a disparu — sans lui, un appelant ` +
        `sans jeton interne valide ne serait plus contrôlé du tout.`
    );
  }
});
