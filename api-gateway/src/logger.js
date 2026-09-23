// src/logger.js

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LE JOURNAL DE LA PASSERELLE — ET SON MASQUAGE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ CE JOURNAL NE MASQUAIT RIEN. Défaut relevé par `observability.md` §6.b et
 * resté ouvert : la passerelle est le SEUL point par lequel passent toutes les
 * requêtes du mobile et du web — donc tous les jetons, tous les codes, toutes
 * les adresses. Un `logger.info(req.body)` posé un jour de débogage y écrivait
 * un mot de passe en clair dans `combined.log`, sans que rien ne le signale.
 *
 * Et un journal se conserve, se copie, s'expédie à un agrégateur. C'est la
 * règle B.4 prise à revers par l'endroit le plus exposé du système.
 *
 * ── DEUX VOIES, PARCE QU'UNE SEULE NE SUFFIT PAS ────────────────────────
 *
 *  1. **par CLÉ** (`redactSensitive`) : `{ password: "x" }` devient
 *     `{ password: "[redacted]" }`. Efficace sur un objet structuré, aveugle
 *     sur du texte libre ;
 *  2. **par VALEUR** (`redactString`) : un JWT, une adresse e-mail, un IBAN ou
 *     un numéro de carte glissés DANS un message sont reconnus à leur forme.
 *     C'est la voie qui attrape `logger.error("échec pour Bearer eyJ…")`.
 *
 * Les deux existaient déjà — `utils/redactSensitive.js` et
 * `services/errorTracking.js`, tous deux testés. On les BRANCHE, on ne les
 * réécrit pas : deux masquages qui divergent, c'est un masquage qui ment.
 *
 * ⚠️ `errorTracking` ne charge Sentry que paresseusement : l'importer ici ne
 * tire aucune dépendance lourde.
 */

const { createLogger, format, transports } = require('winston');
const path = require('path');

const { redactSensitive } = require('./utils/redactSensitive');
const { redactString } = require('./services/errorTracking');

// Détermine l'environnement pour adapter les transports (fichiers surtout en prod)
const isProd = process.env.NODE_ENV === 'production';

/**
 * Le masquage, en format winston.
 *
 * ⚠️ NE LÈVE JAMAIS. Un masquage qui échoue ne doit pas faire disparaître la
 * ligne : on préfère journaliser une ligne non masquée ET le dire, plutôt que
 * perdre l'information au moment où elle sert. Mais on ne se tait pas —
 * l'échec laisse une trace explicite dans la ligne elle-même (règle B.1).
 */
const masquage = format((info) => {
  try {
    const { timestamp, level, message, stack, ...meta } = info;

    /**
     * ⚠️ `redactSensitive` MASQUE PAR CLÉ : il lui faut l'OBJET, pas ses
     * valeurs une par une.
     *
     * Une première version passait chaque valeur isolément — `redactSensitive("hunter2")`
     * — et le masquage ne faisait donc rien : hors de son objet, une valeur n'a
     * plus de clé, donc plus rien à reconnaître. Vérifié en exécutant le
     * logger : `password` ressortait en clair. Un masquage qui ne masque pas
     * est pire que pas de masquage, parce qu'on cesse de se méfier.
     */
    const metaMasque = redactSensitive(meta);

    /**
     * Puis la seconde voie, sur les chaînes qui subsistent : une clé anodine
     * peut contenir un JWT ou une adresse (`{ contexte: "Bearer eyJ…" }`).
     */
    const profondeur = (valeur, niveau = 0) => {
      if (niveau > 6) return valeur; // garde-fou : structures cycliques ou très profondes
      if (typeof valeur === 'string') return redactString(valeur);
      if (Array.isArray(valeur)) return valeur.map((v) => profondeur(v, niveau + 1));
      if (valeur && typeof valeur === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(valeur)) out[k] = profondeur(v, niveau + 1);
        return out;
      }
      return valeur;
    };

    const sortie = { timestamp, level, ...profondeur(metaMasque) };

    if (typeof message === 'string') sortie.message = redactString(message);
    else if (message !== undefined) sortie.message = message;

    if (typeof stack === 'string') sortie.stack = redactString(stack);
    else if (stack !== undefined) sortie.stack = stack;

    /** Winston s'appuie sur ces symboles : les perdre casse le rendu. */
    for (const sym of Object.getOwnPropertySymbols(info)) sortie[sym] = info[sym];

    return sortie;
  } catch (err) {
    return { ...info, _masquage: `ÉCHEC DU MASQUAGE : ${err?.message || err}` };
  }
});

const logger = createLogger({
  level: process.env.LOGS_LEVEL || (isProd ? 'info' : 'debug'),
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),           // Log stack trace des erreurs
    format.splat(),
    /**
     * ⚠️ APRÈS `errors()` ET `splat()`, AVANT `json()`.
     *
     * Après, parce que `errors()` déplie la pile d'une exception et `splat()`
     * interpole les arguments : masquer avant les laisserait produire du texte
     * non masqué. Avant `json()`, parce qu'une fois sérialisé il n'y a plus
     * d'objet à parcourir, seulement une chaîne.
     */
    masquage(),
    format.json()
  ),
  transports: [
    // Console en couleur en dev
    new transports.Console({
      format: isProd
        ? format.simple()
        : format.combine(
            format.colorize(),
            format.printf(({ timestamp, level, message, ...meta }) => {
              // Meta peut contenir l'objet loggué (payload, etc)
              return `[${timestamp}] [${level}] ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
            })
          )
    }),
    // Fichiers en prod et dev (log complet et erreurs)
    new transports.File({
      filename: path.join(__dirname, '..', 'logs', 'combined.log'),
      level: 'info',
      maxsize: 5 * 1024 * 1024,  // 5MB par fichier
      maxFiles: 5,
      tailable: true
    }),
    new transports.File({
      filename: path.join(__dirname, '..', 'logs', 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
      tailable: true
    }),
  ],
  exitOnError: false,
});

// Pour pouvoir logger facilement avec req.logger (middleware si tu veux)
logger.stream = {
  write: (message) => logger.info(message.trim())
};

module.exports = logger;
