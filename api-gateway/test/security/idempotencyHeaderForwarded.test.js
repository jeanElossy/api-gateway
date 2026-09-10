"use strict";

/**
 * ============================================================================
 * LA CLÉ D'IDEMPOTENCE DOIT TRAVERSER LA PASSERELLE
 * ============================================================================
 *
 * ── Ce que ce test empêche de revenir ───────────────────────────────────────
 *
 * `auditForwardHeaders()` ne relaie pas les en-têtes reçus : elle RECONSTRUIT
 * le jeu transmis à TX Core. C'est le bon choix — on ne veut pas qu'un en-tête
 * arbitraire du client atteigne un service interne. Mais la reconstruction
 * omettait `Idempotency-Key`.
 *
 * L'application mobile ne l'envoie QUE dans l'en-tête (`tools/api.js` :
 * `headers: { "Idempotency-Key": … }` ; `buildUnifiedInitiatePayload` n'en met
 * aucune au corps). La clé était donc jetée à la frontière, et TROIS
 * protections tombaient ensemble côté TX Core :
 *
 *   1. `middleware/idempotency.js` ne trouvait aucune clé et laissait passer —
 *      rien n'était écrit dans `idempotency_records`, donc aucun rejeu détecté ;
 *   2. `resolvePersistedIdempotencyKey()` rendait `undefined`, donc le champ
 *      `Transaction.idempotencyKey` restait ABSENT du document ;
 *   3. les index uniques partiels `{sender, idempotencyKey}` et
 *      `{userId, idempotencyKey}` filtrent sur
 *      `idempotencyKey: { $type: "string", $gt: "" }` — un document sans le
 *      champ en est exclu. Les index existaient et ne mordaient sur rien.
 *
 * Deux `/initiate` concurrents créaient deux transactions et RÉSERVAIENT LES
 * FONDS DEUX FOIS.
 *
 * ── Pourquoi un test de COMPORTEMENT et pas de source ───────────────────────
 *
 * Les autres gardes de ce dossier lisent le code source, parce qu'elles
 * interdisent une FORME d'écriture (« ne jamais journaliser un corps »). Ici on
 * exige un RÉSULTAT : « la clé entre, la clé sort ». Une garde textuelle
 * passerait au vert sur une correction qui pose l'en-tête au mauvais endroit,
 * ou qui le pose puis l'écrase. On appelle donc la vraie fonction.
 *
 * ⚠️ Ce test CHARGE `src/config`, qui valide l'environnement au `require` et
 * appelle `process.exit(1)` s'il est incomplet. Les trois variables ci-dessous
 * sont le minimum mesuré pour que le module se charge. Si la validation gagne
 * une variable obligatoire, ce test tombera en le disant — c'est voulu : mieux
 * vaut une garde qui réclame une variable qu'une garde qu'on désactive.
 *
 * ── Comment il tombe ────────────────────────────────────────────────────────
 *
 * Retirer `idempotency-key` du jeu reconstruit dans `phoneSecurity.js` : les
 * trois premiers cas échouent en nommant l'en-tête manquant.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

/* Posées AVANT le require : `src/config` valide au chargement. */
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "a".repeat(32);
process.env.GATEWAY_INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN || "b".repeat(24);
process.env.SERVICE_PAYNOVAL_URL =
  process.env.SERVICE_PAYNOVAL_URL || "http://localhost:1";

const {
  auditForwardHeaders,
  pickIdempotencyHeader,
  IDEMPOTENCY_HEADERS,
} = require("../../src/services/transactions/phoneSecurity");

/** Retrouve un en-tête sans dépendre de la casse produite par la fonction. */
function lireEnTete(headers, nom) {
  const cible = String(nom).toLowerCase();

  for (const cle of Object.keys(headers || {})) {
    if (String(cle).toLowerCase() === cible) return headers[cle];
  }

  return undefined;
}

function requeteAvec(headers) {
  return { headers, user: { _id: "u-1" } };
}

test("la clé d'idempotence envoyée en en-tête est transmise à TX Core", () => {
  const headers = auditForwardHeaders(
    requeteAvec({
      authorization: "Bearer jeton",
      "idempotency-key": "idem-abc-123",
    })
  );

  assert.equal(
    lireEnTete(headers, "idempotency-key"),
    "idem-abc-123",
    "L'en-tête `Idempotency-Key` reçu du client n'est PAS transmis à TX Core. " +
      "Sans lui, le registre d'idempotence, les deux index uniques partiels et " +
      "la protection contre le double appui sont tous inertes : deux /initiate " +
      "concurrents réservent les fonds deux fois."
  );
});

test("la variante `x-idempotency-key` est acceptée et normalisée", () => {
  const headers = auditForwardHeaders(
    requeteAvec({ "x-idempotency-key": "idem-xyz-789" })
  );

  assert.equal(
    lireEnTete(headers, "idempotency-key"),
    "idem-xyz-789",
    "La variante `x-idempotency-key` doit être transmise sous le nom canonique."
  );
});

test("la casse envoyée par le client n'a aucune importance", () => {
  const headers = auditForwardHeaders(
    requeteAvec({ "Idempotency-Key": "idem-casse-mixte" })
  );

  assert.equal(
    lireEnTete(headers, "idempotency-key"),
    "idem-casse-mixte",
    "Un client qui envoie `Idempotency-Key` en casse mixte doit être honoré : " +
      "c'est exactement la graphie de `payNoval-master/tools/api.js`."
  );
});

test("aucun en-tête d'idempotence n'est inventé quand le client n'en envoie pas", () => {
  const headers = auditForwardHeaders(requeteAvec({ authorization: "Bearer j" }));

  assert.equal(
    lireEnTete(headers, "idempotency-key"),
    undefined,
    "Fabriquer une clé côté passerelle ne protégerait de RIEN : elle serait " +
      "neuve à chaque tentative, donc tout rejeu passerait pour une requête " +
      "nouvelle. L'absence de clé doit rester une absence."
  );
});

test("une clé vide ou blanche est traitée comme absente", () => {
  for (const valeur of ["", "   ", "\t"]) {
    const headers = auditForwardHeaders(
      requeteAvec({ "idempotency-key": valeur })
    );

    assert.equal(
      lireEnTete(headers, "idempotency-key"),
      undefined,
      `Une clé « ${JSON.stringify(valeur)} » doit être ignorée, pas transmise : ` +
        "TX Core la rejetterait en 400 et le virement échouerait sur un en-tête vide."
    );
  }
});

test("une valeur en tableau est réduite à sa première entrée", () => {
  const headers = auditForwardHeaders(
    requeteAvec({ "idempotency-key": ["idem-premier", "idem-second"] })
  );

  assert.equal(
    lireEnTete(headers, "idempotency-key"),
    "idem-premier",
    "Un en-tête dupliqué arrive en tableau. Transmettre le tableau tel quel " +
      "produirait `idem-premier,idem-second`, une clé que le client ne " +
      "reproduira jamais au rejeu."
  );
});

test("les autres en-têtes d'audit restent transmis", () => {
  const headers = auditForwardHeaders(
    requeteAvec({
      authorization: "Bearer jeton",
      "x-request-id": "req-1",
      "x-session-id": "sess-1",
      "x-device-id": "dev-1",
      "idempotency-key": "idem-abc-123",
    })
  );

  /* La correction ne doit rien avoir cassé au passage. */
  assert.equal(lireEnTete(headers, "x-request-id"), "req-1");
  assert.equal(lireEnTete(headers, "x-session-id"), "sess-1");
  assert.equal(lireEnTete(headers, "x-device-id"), "dev-1");
  assert.equal(lireEnTete(headers, "authorization"), "Bearer jeton");
  assert.equal(lireEnTete(headers, "x-user-id"), "u-1");
});

/**
 * Les deux noms doivent rester ceux que TX Core sait lire
 * (`api-paynoval/src/utils/idempotencyKeys.js`, `extractIdempotencyKey`).
 * Les dépôts sont séparés : on ne peut pas comparer les listes à l'exécution,
 * mais on peut empêcher qu'un nom disparaisse de celle-ci par inadvertance.
 */
test("les deux graphies reconnues par TX Core sont couvertes", () => {
  assert.deepEqual(
    [...IDEMPOTENCY_HEADERS].sort(),
    ["idempotency-key", "x-idempotency-key"],
    "TX Core (`extractIdempotencyKey`) lit ces deux noms et ceux-là seulement. " +
      "Retirer l'un d'eux ici rouvre le défaut pour les clients qui l'emploient."
  );
});

test("pickIdempotencyHeader respecte la priorité déclarée", () => {
  const valeur = pickIdempotencyHeader({
    headers: {
      "x-idempotency-key": "secondaire",
      "idempotency-key": "principal",
    },
  });

  assert.equal(
    valeur,
    "principal",
    "`idempotency-key` prime sur `x-idempotency-key`, comme côté TX Core."
  );
});
