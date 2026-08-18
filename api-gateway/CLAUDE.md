# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Règles de collaboration transverses → [`../../CLAUDE.md`](../../CLAUDE.md). Vue d'ensemble de l'écosystème PayNoval et conventions de code partagées → [`../../.claude/context/`](../../.claude/context/).

## Projet

PayNoval **API Gateway** : un service Express en frontal de

1. un **backend principal** (le monolithe : auth, users, balance, KYC, notifications, cagnottes…), atteint par proxy HTTP, et
2. des **microservices de paiement par rail** (paynoval, mobilemoney, bank, stripe, visa_direct, cashin, cashout, flutterwave), atteints par des appels axios orchestrés.

Le gateway *possède* aussi nativement quelques domaines (pricing/FX/frais, conformité AML & sanctions, orchestration des transactions) adossés à sa propre base MongoDB.

CommonJS, JavaScript uniquement, pas d'étape de build, aucun linter configuré. Une suite de tests existe (`test/`, runner natif `node:test`).

## Commandes

```bash
npm start                  # node src/server.js
npm test                   # node --test "test/**/*.test.js" — 61 tests dans test/{moderation,pricing}
node --test test/pricing/diff.test.js   # un seul fichier de test
node generate-secrets.js   # régénère JWT_SECRET / INTERNAL_TOKEN et réécrit .env
```

Le glob est **indispensable** : `node --test test/` (l'ancien script, corrigé le 2026-08-18) résout `test/` comme un module CommonJS et échoue en `MODULE_NOT_FOUND` sur Node 22. Les tests couvrent la logique pure (règles de pricing, gardes de modération) et ne démarrent ni serveur ni connexion Mongo — conserver cette propriété pour toute nouvelle suite.

Vérifications runtime : `GET /healthz` (gateway seul), `GET /status` (ping `/health` sur chaque provider activé dans [src/providers.json](src/providers.json)), Swagger UI sur `/docs`, spec brute sur `/openapi.json`.

Le démarrage est fail-fast : [src/config/index.js](src/config/index.js) valide `process.env` avec Joi et appelle `process.exit(1)` à la moindre violation (`JWT_SECRET` et `SERVICE_PAYNOVAL_URL` sont obligatoires ; en production `GATEWAY_INTERNAL_TOKEN` l'est aussi). `MONGO_URI_GATEWAY` / `MONGO_URI_USERS` sont optionnels côté Joi mais [src/db.js](src/db.js) quitte le process sans eux.

## Organisation des dossiers

`routes/`, `controllers/`, `scripts/`, `docs/` sont à la **racine du repo** ; `src/` contient `config/`, `middlewares/`, `models/`, `services/`, `tools/`, `utils/`. D'où les chemins relatifs mixtes (`routes/x.js` fait `require("../src/middlewares/…")`, les services font `require("../../controllers/…")`).

## Pipeline de requête — l'ordre dans [src/app.js](src/app.js) est structurant

1. garde-fou des logs prod → CORS (`setCorsHeaders` manuel + `cors()`) → helmet / mongo-sanitize / xss-clean / hpp → parsers de body
2. limiters spécifiques (login, announcements) → en-têtes `no-store` sur `/api/v1` → limiter global par IP → limiter public
3. docs & health → proxy WebSocket `/socket.io` vers le principal
4. **barrière d'authentification** : tout chemin qui ne correspond *pas* à l'allowlist passe par `authMiddleware` — voir la section dédiée plus bas, la règle n'est plus un simple tableau de préfixes
5. vérification de signature HMAC sur `/api/v1/public/*` → `publicRoutes`
6. `auditHeaders` → limiters par utilisateur (rôles privilégiés ignorés)
7. contrôle de disponibilité Mongo — uniquement pour `mongoRequiredPrefixes[]`
8. **routes natives du gateway**
9. **proxy final** : chaque préfixe de `PRINCIPAL_PREFIXES[]` est transmis à `PRINCIPAL_URL`
10. 404 → gestionnaire d'erreurs

Conséquences quand on ajoute un endpoint :

- Une route native doit être montée **avant** l'étape 9, sinon le proxy l'absorbe. `/api/v1/admin/compliance` est montée avant le proxy `/api/v1/admin` exactement pour cette raison — voir le commentaire à [src/app.js:860](src/app.js#L860).
- Accessible sans JWT → l'ajouter dans `OPEN_EXACT` (ce chemin seul) ou `OPEN_PREFIX` (ce chemin et son sous-arbre). Ne jamais réintroduire une entrée large comme `/api/v1` dans `OPEN_PREFIX`.
- Touche à Mongo → ajouter son préfixe dans `mongoRequiredPrefixes[]` pour renvoyer une 500 propre au lieu de rester bloqué quand la base est down.
- Les réponses d'erreur/429/502 rappellent `setCorsHeaders(req, res)` car elles répondent en dehors du middleware `cors()`. À conserver lors de l'ajout de nouveaux gestionnaires terminaux.

## Barrière d'authentification — refus par défaut, en deux temps

L'ancienne liste mélangeait deux natures de règles dans un seul tableau évalué en préfixe. L'entrée `"/api/v1"` faisait passer **tout** `/api/v1/*` : la barrière ne filtrait plus rien. Aucune porte n'était réellement ouverte (chaque routeur natif réapplique son garde, et le proxy fait réauthentifier le principal), mais la défense en profondeur était réduite à une seule couche.

Corrigé en `24714a7`. Deux tableaux distincts dans [src/app.js](src/app.js) :

- `OPEN_EXACT` — ouvert pour **ce chemin seulement** (racines d'information : `/`, `/api/v1`, `/healthz`, `/status`, `/openapi.json`).
- `OPEN_PREFIX` — ouvert pour ce chemin **et tout son sous-arbre**.

### Bascule `AUTH_BARRIER_STRICT`

`false` par défaut = **report-only** : le comportement historique est conservé, et tout chemin qui *aurait* été bloqué est journalisé en `[AUTH-BARRIER][REPORT]`. Même logique qu'un CSP en report-only — on constitue l'inventaire du trafic réel avant de verrouiller.

**La protection est donc inerte tant que la variable n'est pas passée à `true`.**

Inventaire des appels **sans jeton**, corrigé le 2026-08-12 après lecture des logs réels :

| Client | Chemins appelés sans jeton | Couvert par |
|---|---|---|
| Mobile — `publicApi` (aucun intercepteur d'auth) | `/api/v1/auth/*`, `/api/v1/verification/start-phone` et `/check-phone`, `/api/v1/announcements` | `OPEN_PREFIX` + `OPEN_EXACT` |
| Mobile — `txApi` | `/api/v1/public/*`, `/api/v1/fees/simulate`, `/api/v1/exchange-rates/rate` | `OPEN_PREFIX` |
| Web | `/api/v1/jobs/*`, `/api/v1/auth/*`, `/api/v1/verification/*`, `/api/v1/contact` | `OPEN_PREFIX` |

> ⚠️ **Piège qui a fait échouer un premier inventaire.** Le mobile a **deux** instances axios sans jeton : `publicApi` n'a *aucun* intercepteur d'authentification, et sa liste d'appels n'apparaît nulle part dans le tableau `publicPaths` (qui ne concerne que `txApi`). Vérifier les deux.

`/api/v1/announcements` est en `OPEN_EXACT` et non en préfixe : `/api/v1/announcements/:id/seen` reste protégé.

**Dette de sécurité soldée le 2026-08-12** — `/api/v1/users/avatar-by-email` a figuré dans cette allowlist, au motif erroné qu'elle servait l'écran de connexion. Vérification faite, ses deux appelants (`addPaynoval.js`, `transaction-review.js`) sont post-connexion : il n'y avait aucun arbitrage produit à rendre, seulement un oubli. La route est **retirée de l'allowlist**, le mobile l'appelle désormais via `api` (avec jeton), et le backend la passe derrière `protect` + un limiteur par compte.

Sa voisine `/api/v1/users/info-by-email` était publique elle aussi et fuyait bien davantage — identifiant, nom complet, e-mail, avatar pour toute adresse devinée. Même correctif. **Elle n'est pas orpheline** : trois appelants passent par le helper `fetchUserByEmail` (deux écrans mobile, un écran back-office), invisibles si l'on cherche le chemin d'URL plutôt que le helper. Ne pas la supprimer.

Conséquence pour tester : un appel sans jeton sur ces deux routes est désormais rejeté **par le gateway**, avant tout proxy. Un `401` obtenu ici ne prouve donc rien sur le `protect` du backend — pour valider les deux couches, viser aussi le backend en direct.

**Avant de basculer** : laisser tourner en report-only le temps d'un cycle d'usage réel et vérifier que les logs `[AUTH-BARRIER][WOULD-BLOCK]` sont silencieux. Ces logs ne signalent que les requêtes **sans identifiant exploitable** — les seules qui casseraient. Une première version journalisait tout chemin hors allowlist, y compris les requêtes authentifiées : des milliers de lignes de bruit, inexploitables.

## Authentification : trois identifiants distincts

| Identifiant | Où | Notes |
|---|---|---|
| **JWT** user/admin | `Authorization: Bearer` | Vérifié avec `JWT_SECRET`/`PRINCIPAL_JWT_SECRET`, puis l'utilisateur est **chargé depuis la base users**. Les rôles `admin`/`superadmin`/`support` contournent les limiters utilisateur ; `requireRole` est dans [src/middlewares/authz.js](src/middlewares/authz.js). |
| **Token interne** | `x-internal-token` | `GATEWAY_INTERNAL_TOKEN` (fallback `INTERNAL_TOKEN`), comparé en temps constant. Accepté **uniquement** sur `INTERNAL_ALLOWED_PREFIXES` dans [src/middlewares/auth.js](src/middlewares/auth.js), pour qu'un token fuité ne pilote pas tout le gateway. Positionne `req.user = { system: true, role: "internal-service" }` — attention : `requireRole` laisse passer `internal-service` sur *n'importe quel* contrôle de rôle. |
| **HMAC public** | `x-signature` + `x-ts` | Pour `/api/v1/public/*`. Payload canonique `ts\nMETHOD\npath\nqueryTriée` en HMAC-SHA256 avec `PUBLIC_READONLY_HMAC_SECRET`, fenêtre anti-rejeu `PUBLIC_SIGNATURE_TTL_SEC`. Implémenté dans `config.verifyPublicSignature`. `/public/fx/latest` et `/public/fx/history` sont exemptés. |

En sortie vers le principal, le proxy injecte `x-internal-token: PRINCIPAL_INTERNAL_TOKEN` et `x-forwarded-service: api-gateway`, et retransmet `Authorization`, le request-id, l'idempotency et les en-têtes analytics.

## Deux connexions MongoDB

- `mongoose.connect()` → **base gateway** (`MONGO_URI_GATEWAY`) : tous les modèles de `src/models/` sauf le modèle utilisateur.
- `mongoose.createConnection()` → **base users** (`MONGO_URI_USERS`), exposée via `getUsersConnection()`. [src/models/userModel.js](src/models/userModel.js) est une *factory* qui lie le schéma à cette connexion. Ne jamais enregistrer le modèle user sur la connexion par défaut.

## Orchestration des transactions (flow-first)

[routes/transactions.js](routes/transactions.js) → [controllers/transactionsController.js](controllers/transactionsController.js) (mince, uniquement la mise en forme des erreurs) → [src/services/transactions/](src/services/transactions/).

- **Le flow est la vérité métier ; le provider n'est qu'un détail d'exécution.** `flowResolver` mappe `(action, funds, destination)` vers une constante `TRANSACTION_FLOWS` ([transactionFlow.constants.js](src/services/transactions/transactionFlow.constants.js)) ; le provider est déduit du flow. Ne pas router sur un `body.provider` brut seul.
- Pour `confirm`/`cancel`/actions admin, l'orchestrateur récupère d'abord la **transaction canonique** depuis PayNoval / TX Core et route sur *son* flow ; le body de la requête est le dernier recours. `transactionOrchestratorByFlow.js` + `providerAdapters/{paynoval,mobilemoney,bank,card}Adapter.js` font le dispatch, `adminFlowRouter.js` gère les actions admin.
- `providerRegistry.js` associe un nom de provider à l'URL de base d'un microservice via `config.microservices` (variables `SERVICE_*_URL`). Les opérateurs mobile money (`wave`, `orange`, `mtn`, `moov`, `flutterwave`) sont ramenés au provider `mobilemoney`, l'opérateur étant déplacé dans `body.metadata.provider`.
- Tout appel sortant vers un provider passe par `safeAxiosRequest` ([httpClient.js](src/services/transactions/httpClient.js)) : User-Agent gateway, détection des challenges Cloudflare, et **cooldown** LRU par origine sur 429/challenge qui court-circuite les appels suivants en 503 avec `retryAfterSec`.
- `providers.json` / [src/providers.js](src/providers.js) est une surface *séparée*, utilisée uniquement par `GET /status` ; le routage ne la lit pas.

## Éligibilité & conformité

- `requireTransactionEligibility` ([src/middlewares/requireTransactionEligibility.js](src/middlewares/requireTransactionEligibility.js)) rappelle `/api/v1/users/me` sur le principal à chaque `initiate`/`confirm` — choix délibéré de faire confiance à un **profil frais plutôt qu'aux claims du JWT** — et bloque sur email/téléphone non vérifiés, KYC (particulier) ou KYB (entreprise) manquant, ou compte bloqué/gelé/en attente, en renvoyant un `code` avec 428/403/401. `cancel` s'en affranchit volontairement pour qu'un utilisateur puisse toujours libérer des fonds en attente.
- AML : `src/middlewares/aml.js` + `src/services/aml.js` + `sanctionsScreeningService.js` (SumSub / ComplyAdvantage / ComplyAdvantage Mesh, sélectionné par les variables `SANCTIONS_SCREENING_*`, avec un interrupteur fail-open/fail-closed), persisté dans `AMLLog`. Lecture admin : `GET /api/v1/admin/compliance/transactions`.

## Pricing / FX

`pricingEngine.js` avec les modèles `PricingRule` / `PricingQuote` ; `/api/v1/pricing/quote|preview` sont ouverts, `/lock` exige un JWT. Frais (`Fee`), taux de change (`ExchangeRate`), règles FX (`FxRule`) ont chacun un CRUD admin protégé par `requireAdmin` (les frais acceptent aussi le token interne).

**Règle devises** — seuls les codes ISO (`EUR`, `XOF`, `XAF`, `CAD`, `USD`) sont stockés et transportés ; jamais de symboles type `€` ou `F CFA`. Une transaction porte un côté source (`amountSource`/`currencySource`/`feeSource`) et un côté target. Voir [src/help/multi-currency.md](src/help/multi-currency.md).

## Conventions

- Architecture en couches : routes → controllers → services → models. Les routes ne contiennent aucune logique métier, les controllers restent minces.
- Format de réponse `{ success: boolean, ... }` avec `data` en cas de succès et `error` + souvent `message`/`code` en cas d'échec. **Les messages destinés à l'utilisateur sont en français** ; les identifiants et le code restent en anglais. Les explications à l'utilisateur se font en français (voir [`../../.claude/context/conventions.md`](../../.claude/context/conventions.md) — le `.claude/` présent dans ce dépôt est une copie obsolète d'un ancien template, ne pas s'y fier). Ne pas convertir le projet en TypeScript.
- De nombreux services/routes utilisent un helper défensif `reqAny([...chemins])` qui essaie plusieurs chemins de require. Il existe à cause du découpage racine/`src` — le conserver lors des modifications plutôt que de le « nettoyer » en un require unique.
- [src/app.js](src/app.js) réduit `console.*` au silence en production (`SILENCE_PROD_LOGS`, `SHOW_PROD_WARNINGS`). Tout ce qui doit survivre en production passe par le `logger` winston ([src/logger.js](src/logger.js)), qui écrit aussi `logs/combined.log` et `logs/error.log`.
- Les messages de commit de l'historique suivent le format `gateway paynoval file update vNNN`.

## Code mort / obsolète — ne pas prendre comme référence

- [scripts/migrate-currency.js](scripts/migrate-currency.js) et [scripts/seedPricingRules.js](scripts/seedPricingRules.js) sont **intégralement commentés**.
- [src/services/configSyncService.js](src/services/configSyncService.js) et [src/services/transactionPricingService.js](src/services/transactionPricingService.js) requièrent `pino`, qui n'est pas une dépendance — les charger lève une exception. Rien ne les importe.
- `src/openapi.yaml` est vide ; c'est [docs/openapi.yaml](docs/openapi.yaml) qui est réellement servi.
- Non montés dans `src/app.js` : `routes/exchangeRates.routes.js` (copie à la racine — celui monté est `routes/admin/exchangeRates.routes.js`), `routes/phoneVerificationRoutes.js`, `routes/principalProxyRoutes.js`, `routes/trustedDepositNumberRoutes.js`. Middlewares inutilisés : `src/middlewares/gatewayAuth.js`, `src/middlewares/validate.js`.
