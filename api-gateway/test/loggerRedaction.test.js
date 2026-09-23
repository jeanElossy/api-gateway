"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LE JOURNAL DE LA PASSERELLE MASQUE-T-IL VRAIMENT ?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Défaut relevé par `observability.md` §6.b et resté ouvert : ce journal ne
 * masquait RIEN. Or la passerelle est le seul point par lequel passent toutes
 * les requêtes du mobile et du web — donc tous les jetons, tous les codes,
 * toutes les adresses. Un `logger.info(req.body)` posé un jour de débogage y
 * écrivait un mot de passe en clair dans `combined.log`.
 *
 * ⚠️ CE TEST A DÉJÀ SERVI. Une première version du correctif passait chaque
 * valeur isolément à `redactSensitive`, qui masque PAR CLÉ : hors de son objet,
 * une valeur n'a plus de clé, donc plus rien à reconnaître. `password`
 * ressortait en clair, et le correctif donnait l'illusion d'en être un.
 * **Un masquage qui ne masque pas est pire que pas de masquage, parce qu'on
 * cesse de se méfier.**
 *
 * PUR : aucune requête, aucun serveur. Les transports sont mis en sourdine et
 * on lit le flux du logger.
 */

const logger = require("../src/logger");

/** Journalise une ligne et rend l'objet tel que les transports le verraient. */
function capture(niveau, message, meta) {
  return new Promise((resolve) => {
    const recues = [];
    const onData = (info) => recues.push(info);

    logger.transports.forEach((t) => {
      t.silent = true;
    });
    logger.on("data", onData);
    logger[niveau](message, meta);

    setTimeout(() => {
      logger.off("data", onData);
      resolve(recues[recues.length - 1] || {});
    }, 60);
  });
}

test("masque un JWT glissé dans le MESSAGE", async () => {
  const l = await capture(
    "info",
    "refus pour Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij",
    {}
  );

  assert.ok(!l.message.includes("eyJhbGciOiJIUzI1NiJ9"), "le jeton ne doit pas survivre");
  assert.match(l.message, /\[redacted\]|\[jwt\]/);
});

test("masque PAR CLÉ — le défaut du premier correctif", async () => {
  const l = await capture("info", "tentative", { password: "hunter2", pin: "1234" });

  assert.notEqual(l.password, "hunter2");
  assert.notEqual(l.pin, "1234");
});

test("masque PAR VALEUR sous une clé anodine", async () => {
  const l = await capture("info", "contexte", {
    contexte: "jeton eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij",
    ecrit: "ecrire a jean.elossy@gmail.com",
  });

  assert.ok(!String(l.contexte).includes("eyJhbGciOiJIUzI1NiJ9"));
  assert.ok(!String(l.ecrit).includes("jean.elossy@gmail.com"));
});

test("descend dans les objets imbriqués", async () => {
  const l = await capture("info", "imbrique", {
    niveau1: { refreshToken: "zzz", niveau2: { email: "jean.elossy@gmail.com" } },
  });

  const texte = JSON.stringify(l.niveau1);
  assert.ok(!texte.includes("zzz"));
  assert.ok(!texte.includes("jean.elossy@gmail.com"));
});

/**
 * ⚠️ UN MASQUAGE QUI MASQUE TOUT NE SERT À RIEN NON PLUS. Si les valeurs
 * anodines disparaissaient, le journal deviendrait illisible et on finirait
 * par le désactiver — donc par ne plus rien avoir du tout.
 */
test("laisse passer ce qui est anodin", async () => {
  const l = await capture("info", "requete traitee en 42 ms", {
    ok: 1,
    route: "/api/v1/pricing/quote",
    duree: 42,
  });

  assert.equal(l.message, "requete traitee en 42 ms");
  assert.equal(l.ok, 1);
  assert.equal(l.route, "/api/v1/pricing/quote");
  assert.equal(l.duree, 42);
});

test("masque la pile d'une exception", async () => {
  const err = new Error("echec avec Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij");
  const l = await capture("error", err.message, { stack: err.stack });

  assert.ok(!JSON.stringify(l).includes("eyJhbGciOiJIUzI1NiJ9"));
});

test("ne perd ni le niveau ni l'horodatage", async () => {
  const l = await capture("warn", "attention", { ok: 1 });

  assert.equal(l.level, "warn");
  assert.ok(typeof l.timestamp === "string" && l.timestamp.length > 0);
});

/**
 * Le masquage ne doit jamais faire disparaître une ligne : on préfère une
 * ligne non masquée ET signalée plutôt que rien au moment où ça sert.
 */
test("survit à une méta cyclique au lieu de perdre la ligne", async () => {
  const cyclique = { nom: "a" };
  cyclique.soi = cyclique;

  const l = await capture("info", "cyclique", { cyclique });
  assert.ok(l && l.message === "cyclique");
});
