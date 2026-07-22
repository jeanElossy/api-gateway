# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Projet

PayNoval **API Gateway** : un service Express en frontal de

1. un **backend principal** (le monolithe : auth, users, balance, KYC, notifications, cagnottes…), atteint par proxy HTTP, et
2. des **microservices de paiement par rail** (paynoval, mobilemoney, bank, stripe, visa_direct, cashin, cashout, flutterwave), atteints par des appels axios orchestrés.

Le gateway *possède* aussi nativement quelques domaines (pricing/FX/frais, conformité AML & sanctions, orchestration des transactions) adossés à sa propre base MongoDB.

CommonJS, JavaScript uniquement, pas d'étape de build, pas de suite de tests, aucun linter configuré.

## Commandes

```bash
npm start                  # node src/server.js — le seul script npm
node generate-secrets.js   # régénère JWT_SECRET / INTERNAL_TOKEN et réécrit .env
```

Vérifications runtime : `GET /healthz` (gateway seul), `GET /status` (ping `/health` sur chaque provider activé dans [src/providers.json](src/providers.json)), Swagger UI sur `/docs`, spec brute sur `/openapi.json`.

Le démarrage est fail-fast : [src/config/index.js](src/config/index.js) valide `process.env` avec Joi et appelle `process.exit(1)` à la moindre violation (`JWT_SECRET` et `SERVICE_PAYNOVAL_URL` sont obligatoires ; en production `GATEWAY_INTERNAL_TOKEN` l'est aussi). `MONGO_URI_GATEWAY` / `MONGO_URI_USERS` sont optionnels côté Joi mais [src/db.js](src/db.js) quitte le process sans eux.

## Organisation des dossiers

`routes/`, `controllers/`, `scripts/`, `docs/` sont à la **racine du repo** ; `src/` contient `config/`, `middlewares/`, `models/`, `services/`, `tools/`, `utils/`. D'où les chemins relatifs mixtes (`routes/x.js` fait `require("../src/middlewares/…")`, les services font `require("../../controllers/…")`).

## Pipeline de requête — l'ordre dans [src/app.js](src/app.js) est structurant

1. garde-fou des logs prod → CORS (`setCorsHeaders` manuel + `cors()`) → helmet / mongo-sanitize / xss-clean / hpp → parsers de body
2. limiters spécifiques (login, announcements) → en-têtes `no-store` sur `/api/v1` → limiter global par IP → limiter public
3. docs & health → proxy WebSocket `/socket.io` vers le principal
4. **barrière d'authentification** : tout chemin qui ne correspond *pas* à `openEndpoints[]` passe par `authMiddleware`
5. vérification de signature HMAC sur `/api/v1/public/*` → `publicRoutes`
6. `auditHeaders` → limiters par utilisateur (rôles privilégiés ignorés)
7. contrôle de disponibilité Mongo — uniquement pour `mongoRequiredPrefixes[]`
8. **routes natives du gateway**
9. **proxy final** : chaque préfixe de `PRINCIPAL_PREFIXES[]` est transmis à `PRINCIPAL_URL`
10. 404 → gestionnaire d'erreurs

Conséquences quand on ajoute un endpoint :

- Une route native doit être montée **avant** l'étape 9, sinon le proxy l'absorbe. `/api/v1/admin/compliance` est montée avant le proxy `/api/v1/admin` exactement pour cette raison — voir le commentaire à [src/app.js:860](src/app.js#L860).
- Accessible sans JWT → l'ajouter dans `openEndpoints[]`.
- Touche à Mongo → ajouter son préfixe dans `mongoRequiredPrefixes[]` pour renvoyer une 500 propre au lieu de rester bloqué quand la base est down.
- Les réponses d'erreur/429/502 rappellent `setCorsHeaders(req, res)` car elles répondent en dehors du middleware `cors()`. À conserver lors de l'ajout de nouveaux gestionnaires terminaux.

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
- Format de réponse `{ success: boolean, ... }` avec `data` en cas de succès et `error` + souvent `message`/`code` en cas d'échec. **Les messages destinés à l'utilisateur sont en français** ; les identifiants et le code restent en anglais. Les explications à l'utilisateur se font en français (voir [.claude/memory/conventions.md](.claude/memory/conventions.md)). Ne pas convertir le projet en TypeScript.
- De nombreux services/routes utilisent un helper défensif `reqAny([...chemins])` qui essaie plusieurs chemins de require. Il existe à cause du découpage racine/`src` — le conserver lors des modifications plutôt que de le « nettoyer » en un require unique.
- [src/app.js](src/app.js) réduit `console.*` au silence en production (`SILENCE_PROD_LOGS`, `SHOW_PROD_WARNINGS`). Tout ce qui doit survivre en production passe par le `logger` winston ([src/logger.js](src/logger.js)), qui écrit aussi `logs/combined.log` et `logs/error.log`.
- Les messages de commit de l'historique suivent le format `gateway paynoval file update vNNN`.

## Code mort / obsolète — ne pas prendre comme référence

- [scripts/migrate-currency.js](scripts/migrate-currency.js) et [scripts/seedPricingRules.js](scripts/seedPricingRules.js) sont **intégralement commentés**.
- [src/services/configSyncService.js](src/services/configSyncService.js) et [src/services/transactionPricingService.js](src/services/transactionPricingService.js) requièrent `pino`, qui n'est pas une dépendance — les charger lève une exception. Rien ne les importe.
- `src/openapi.yaml` est vide ; c'est [docs/openapi.yaml](docs/openapi.yaml) qui est réellement servi.
- Non montés dans `src/app.js` : `routes/exchangeRates.routes.js` (copie à la racine — celui monté est `routes/admin/exchangeRates.routes.js`), `routes/phoneVerificationRoutes.js`, `routes/principalProxyRoutes.js`, `routes/trustedDepositNumberRoutes.js`. Middlewares inutilisés : `src/middlewares/gatewayAuth.js`, `src/middlewares/validate.js`.
- Les fichiers `.claude/docs/*.md` sont un modèle copié depuis un projet React sans rapport (« CAVA Website ») et ne décrivent pas ce gateway.
