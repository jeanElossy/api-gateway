"use strict";

/**
 * --------------------------------------------------------------------------
 * Transaction Orchestrator By Flow
 * --------------------------------------------------------------------------
 * Gateway = orchestrateur métier léger.
 *
 * Règles :
 * - initiate : le flow peut être résolu depuis le body
 * - confirm/cancel/... : on tente d'abord de lire la transaction canonique
 *   existante depuis le service PayNoval/TX Core
 * - le provider réel d'une action doit venir en priorité :
 *   1) de la transaction canonique
 *   2) du flow
 *   3) du body en dernier recours
 *
 * Correctifs robustesse :
 * - normalisation des security fields
 * - normalisation des pays (FR, CI, ...)
 * - normalisation method / txType
 * - support pricingId OU quoteId
 * - support payload mobile "souple" -> payload TX Core "strict"
 * - logs détaillés gateway
 * --------------------------------------------------------------------------
 */

const {
  TRANSACTION_FLOWS,
  getDefaultProviderForFlow,
} = require("./transactionFlow.constants");

const {
  getTargetService,
  normalizeMobileMoneyProviderInBody,
  normalizeProviderForRouting,
} = require("./providerRegistry");

const { resolveTransactionFlow } = require("./flowResolver");
const { getUserId, auditForwardHeaders } = require("./phoneSecurity");
const { safeAxiosRequest } = require("./httpClient");

const { postToPaynovalService } = require("./providerAdapters/paynovalAdapter");
const { postToMobileMoneyService } = require("./providerAdapters/mobilemoneyAdapter");
const { postToCardService } = require("./providerAdapters/cardAdapter");

/**
 * ⚠️ MASQUAGE OBLIGATOIRE AVANT TOUTE JOURNALISATION D'UN CORPS DE REQUÊTE.
 *
 * `redactSensitive` a été écrit exactement pour ce fichier — son en-tête le dit
 * — et n'était importé **nulle part**. Le module existait, la fuite aussi :
 * `console.log("raw body", req.body)` écrivait la RÉPONSE À LA QUESTION DE
 * SÉCURITÉ en clair à chaque `/initiate`.
 *
 * Ce n'était muet en production que parce que `SILENCE_PROD_LOGS` réduit
 * `console.log` au silence. **Un secret protégé par un interrupteur n'est pas
 * protégé** : il suffit qu'on relève le niveau de journal une heure pour
 * diagnostiquer un incident — c'est-à-dire précisément le moment où on le fait.
 */
const { redactSensitive } = require("../../utils/redactSensitive");

function cleanBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function norm(v) {
  return String(v || "").trim();
}

function lower(v) {
  return norm(v).toLowerCase();
}

function upper(v) {
  return norm(v).toUpperCase();
}

function isNil(v) {
  return v === undefined || v === null;
}

function toSafeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserializable]";
  }
}

function cleanUndefinedDeep(value) {
  if (Array.isArray(value)) {
    return value.map(cleanUndefinedDeep);
  }

  if (!value || typeof value !== "object") return value;

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (isNil(val)) continue;
    out[key] = cleanUndefinedDeep(val);
  }
  return out;
}

const COUNTRY_ALIASES = {
  "cote d'ivoire": "CI",
  "cote d ivoire": "CI",
  "cote divoire": "CI",
  "ivory coast": "CI",
  france: "FR",
  belgique: "BE",
  belgium: "BE",
  allemagne: "DE",
  germany: "DE",
  canada: "CA",
  usa: "US",
  us: "US",
  "united states": "US",
  senegal: "SN",
  mali: "ML",
  "burkina faso": "BF",
  cameroun: "CM",
  cameroon: "CM",
};

function normalizeCountry(v) {
  const raw = lower(v)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (!raw) return "";

  if (/^[A-Z]{2}$/i.test(norm(v))) {
    return upper(v);
  }

  if (COUNTRY_ALIASES[raw]) {
    return COUNTRY_ALIASES[raw];
  }

  return upper(raw);
}

function normalizeTxType(v) {
  const txType = upper(v);
  if (txType === "DEPOSIT") return "DEPOSIT";
  if (txType === "WITHDRAW") return "WITHDRAW";
  return "TRANSFER";
}

function normalizeMethod(v, { funds = "", destination = "", provider = "" } = {}) {
  const method = upper(v);
  const f = lower(funds);
  const d = lower(destination);
  const p = lower(provider);

  if (method === "INTERNAL") return "INTERNAL";

  if (f === "paynoval" && d === "paynoval") {
    return "INTERNAL";
  }

  if (method === "CARD") return "CARD";
  if (method === "MOBILEMONEY") return "MOBILEMONEY";
  if (method === "MOBILE_MONEY") return "MOBILEMONEY";

  if (d === "mobilemoney" || p === "mobilemoney") return "MOBILEMONEY";
  /* « stripe » retiré le 2026-09-09. */
  if (d === "card" || p === "visa_direct" || p === "visadirect") return "CARD";

  return method || "INTERNAL";
}

function normalizeSecurityFields(body = {}) {
  const out = { ...(body || {}) };

  out.securityQuestion =
    out.securityQuestion || out.question || out.validationQuestion || null;

  out.securityAnswer =
    out.securityAnswer || out.securityCode || out.validationCode || null;

  return out;
}

function extractCanonicalTx(payload) {
  if (!payload || typeof payload !== "object") return null;
  return payload.data || payload.transaction || payload;
}

function getTransactionIdFromReq(req) {
  return (
    req.body?.transactionId ||
    req.params?.transactionId ||
    req.params?.id ||
    req.query?.transactionId ||
    null
  );
}

function getProviderForFlow({ flow, body, canonicalTx = null }) {
  const requestedProvider = String(
    canonicalTx?.provider ||
      canonicalTx?.metadata?.provider ||
      canonicalTx?.providerSelected ||
      body?.providerSelected ||
      body?.provider ||
      body?.metadata?.provider ||
      ""
  )
    .trim()
    .toLowerCase();

  if (flow === TRANSACTION_FLOWS.PAYNOVAL_INTERNAL_TRANSFER) {
    return "paynoval";
  }

  if (
    flow === TRANSACTION_FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL ||
    flow === TRANSACTION_FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT
  ) {
    return "mobilemoney";
  }

  /**
   * Rail carte : Visa Direct dans les DEUX sens depuis le retrait de Stripe
   * (2026-09-09). Le dépôt renvoyait « stripe », c'est-à-dire un rail dont
   * l'adapter a été supprimé côté Tx Core : la requête partait vers un service
   * que plus rien ne sert.
   */
  if (
    flow === TRANSACTION_FLOWS.CARD_TOPUP_TO_PAYNOVAL ||
    flow === TRANSACTION_FLOWS.PAYNOVAL_TO_CARD_PAYOUT
  ) {
    return "visa_direct";
  }

  return normalizeProviderForRouting(
    requestedProvider || getDefaultProviderForFlow(flow)
  );
}

async function fetchCanonicalTransaction(req, transactionId) {
  const paynovalServiceUrl = getTargetService("paynoval");
  if (!paynovalServiceUrl || !transactionId) return null;

  const url = `${cleanBaseUrl(paynovalServiceUrl)}/transactions/${encodeURIComponent(
    transactionId
  )}`;

  console.log("[Gateway][fetchCanonicalTransaction] start", {
    transactionId,
    url,
  });

  try {
    const response = await safeAxiosRequest({
      method: "get",
      url,
      headers: auditForwardHeaders(req),
      timeout: 10000,
    });

    const extracted = extractCanonicalTx(response.data || {});

    console.log("[Gateway][fetchCanonicalTransaction] success", {
      transactionId,
      found: !!extracted,
      provider: extracted?.provider,
      flow: extracted?.flow,
      status: extracted?.status,
    });

    return extracted;
  } catch (err) {
    console.error("[Gateway][fetchCanonicalTransaction] failed", {
      transactionId,
      message: err?.message,
      status: err?.status || err?.response?.status,
      responseData: err?.response?.data,
    });
    return null;
  }
}

function normalizeRecipientInfo(body = {}) {
  const original =
    body?.recipientInfo && typeof body.recipientInfo === "object"
      ? body.recipientInfo
      : {};

  const email = lower(body?.toEmail || original?.email || original?.mail || "");
  let name = norm(
    original?.name ||
      original?.accountHolderName ||
      original?.holder ||
      ""
  );

  if (email && name && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name)) {
    name = "";
  }

  return cleanUndefinedDeep({
    ...original,
    email: email || undefined,
    name: name || undefined,
    accountHolderName: norm(original?.accountHolderName || name) || undefined,
    holder: norm(original?.holder) || undefined,
    bankName: norm(original?.bankName) || undefined,
    country: norm(original?.country) || undefined,
    generic: norm(original?.generic) || undefined,
    operator: norm(original?.operator) || undefined,
    phone: norm(original?.phone) || undefined,
    numero: norm(original?.numero) || undefined,
    summary: norm(original?.summary) || name || email || undefined,
  });
}

function buildStrictInitiateBody(rawBody = {}, flow, provider) {
  const body = normalizeSecurityFields(rawBody || {});

  const funds = lower(body.funds);
  const destination = lower(body.destination);
  const normalizedProvider = lower(
    provider || body.provider || funds || destination || "paynoval"
  );

  const method = normalizeMethod(body.method, {
    funds,
    destination,
    provider: normalizedProvider,
  });

  const txType = normalizeTxType(body.txType);

  const pricingId = norm(body.pricingId);
  const quoteId = norm(body.quoteId);
  const effectivePricingId = pricingId || quoteId;

  const country = normalizeCountry(
    body.country || body.toCountry || body.destinationCountry
  );

  const fromCountry = normalizeCountry(
    body.fromCountry || body.sourceCountry || body.country
  );

  const toCountry = normalizeCountry(
    body.toCountry || body.destinationCountry || body.country
  );

  const recipientInfo = normalizeRecipientInfo(body);
  const toEmail = lower(body.toEmail || recipientInfo?.email || "");

  const amountSource = Number(body.amountSource ?? body.amount ?? 0) || 0;
  const feeSource = Number(body.feeSource ?? body.transactionFees ?? 0) || 0;
  const amountTarget = Number(body.amountTarget ?? body.localAmount ?? 0) || 0;
  const exchangeRate =
    Number(body.fxRateSourceToTarget ?? body.exchangeRate ?? 0) || 0;

  const strictBody = cleanUndefinedDeep({
    ...body,

    provider: normalizedProvider,
    funds,
    destination,
    method,
    txType,

    pricingId: pricingId || undefined,
    quoteId: quoteId || undefined,
    effectivePricingId: effectivePricingId || undefined,

    country: country || undefined,
    fromCountry: fromCountry || undefined,
    toCountry: toCountry || undefined,
    sourceCountry: fromCountry || undefined,
    destinationCountry: toCountry || undefined,
    targetCountry: toCountry || undefined,

    toEmail: toEmail || undefined,
    recipientInfo,

    securityQuestion: norm(body.securityQuestion) || undefined,
    securityAnswer: norm(body.securityAnswer) || undefined,

    amount: amountSource,
    amountSource,
    feeSource,
    amountTarget,
    exchangeRate,
    fxRateSourceToTarget: exchangeRate,

    currency: upper(body.currency || body.currencySource || ""),
    currencySource: upper(body.currencySource || body.currency || ""),
    currencyTarget: upper(body.currencyTarget || body.localCurrencyCode || ""),
    senderCurrencyCode: upper(
      body.senderCurrencyCode || body.currencySource || body.currency || ""
    ),
    localCurrencyCode: upper(
      body.localCurrencyCode || body.currencyTarget || ""
    ),

    meta: cleanUndefinedDeep({
      ...(body.meta || {}),
      flow:
        body?.meta?.flow ||
        (flow === TRANSACTION_FLOWS.PAYNOVAL_INTERNAL_TRANSFER
          ? "PAYNOVAL_TO_PAYNOVAL"
          : "EXTERNAL"),
      pricingId: pricingId || undefined,
      quoteId: quoteId || undefined,
      effectivePricingId: effectivePricingId || undefined,
    }),
  });

  return strictBody;
}

async function resolveRouteContextForAction(req, action) {
  normalizeMobileMoneyProviderInBody(req);

  const body =
    action === "confirm"
      ? normalizeSecurityFields(req.body || {})
      : { ...(req.body || {}) };

  /**
   * ⚠️ `redactSensitive` N'EST PAS FACULTATIF ICI. Sur `action === "confirm"`,
   * `body` sort de `normalizeSecurityFields()` : il porte le CODE DE
   * CONFIRMATION en clair, recopié depuis `securityCode`/`validationCode`.
   *
   * Le masquage manquait, et le test de garde ne l'a pas vu : son motif ne
   * reconnaissait que `req.body`, `bodyWithSecurity`, `strictBody` et
   * `rawBody`. La variable s'appelle ici `body` — un nom qu'il ignorait. Le
   * motif a été élargi en même temps que ce correctif (règle B.5 : un test qui
   * passe avant ET après ne teste rien).
   */
  console.log("[Gateway][resolveRouteContextForAction] input", {
    action,
    body: redactSensitive(body),
  });

  const transactionId = getTransactionIdFromReq(req);
  const canonicalTx = transactionId
    ? await fetchCanonicalTransaction(req, transactionId)
    : null;

  const flow =
    canonicalTx?.flow ||
    req.transactionFlow ||
    resolveTransactionFlow(body || {});

  const provider = getProviderForFlow({
    flow,
    body,
    canonicalTx,
  });

  const serviceUrl = getTargetService(provider);

  console.log("[Gateway][resolveRouteContextForAction] resolved", {
    action,
    transactionId,
    flow,
    provider,
    serviceUrl,
    canonicalFound: !!canonicalTx,
    canonicalProvider: canonicalTx?.provider,
    canonicalFlow: canonicalTx?.flow,
  });

  if (!serviceUrl) {
    const e = new Error(`Aucun service configuré pour le provider: ${provider}`);
    e.status = 400;
    throw e;
  }

  req.transactionFlow = flow;
  req.providerSelected = provider;
  req.routedProvider = provider;

  return {
    flow,
    provider,
    serviceUrl,
    body,
    canonicalTx,
  };
}

async function dispatchToProvider({ req, provider, serviceUrl, endpoint, body }) {
  /**
   * ⚠️ `body` est ici le `strictBody` construit par `routeInitiateByFlow` : il
   * DÉRIVE de `bodyWithSecurity` et porte donc la réponse à la question de
   * sécurité en clair. L'appelant masque déjà sa propre copie
   * (`[routeInitiateByFlow][strictBody]`) — celui-ci l'écrivait nu, trois
   * lignes plus loin, sous un nom de variable que le test de garde ne
   * surveillait pas.
   */
  console.log("[Gateway][dispatchToProvider] start", {
    provider,
    serviceUrl,
    endpoint,
    body: redactSensitive(body),
  });

  try {
    let out;

    switch (provider) {
      case "mobilemoney":
        out = await postToMobileMoneyService({
          req,
          serviceUrl,
          endpoint,
          body,
        });
        break;

      /* « stripe » retiré du routage le 2026-09-09. */
      case "visa_direct":
      case "visadirect":
        out = await postToCardService({
          req,
          serviceUrl,
          endpoint,
          body,
        });
        break;

      case "paynoval":
      default:
        out = await postToPaynovalService({
          req,
          serviceUrl,
          endpoint,
          body,
        });
        break;
    }

    /**
     * Ici `body` est la RÉPONSE de TX Core, pas la requête du client. Le
     * sérialiseur de transaction y retire déjà `securityCode`,
     * `securityAnswerHash` et `verificationToken`, donc le risque est faible.
     *
     * On masque quand même, pour deux raisons. D'abord la défense en
     * profondeur : ce masquage est la seule chose qui protégerait ce journal
     * si un champ sensible réapparaissait un jour dans la réponse — et on ne
     * veut pas que la protection dépende du souvenir qu'un autre fichier fait
     * bien son travail. Ensuite la lisibilité de la règle : « aucun corps ne
     * se journalise nu » n'a pas d'exception à retenir, donc pas d'exception à
     * mal appliquer.
     */
    console.log("[Gateway][dispatchToProvider] success", {
      provider,
      endpoint,
      status: out?.status,
      body: redactSensitive(out?.body),
    });

    return out;
  } catch (err) {
    console.error("[Gateway][dispatchToProvider] failed", {
      provider,
      endpoint,
      serviceUrl,
      message: err?.message,
      status: err?.status || err?.response?.status,
      payload: err?.payload,
      responseData: err?.response?.data,
      stack: err?.stack,
      body,
    });
    throw err;
  }
}

async function routeInitiateByFlow(req) {
  try {
    normalizeMobileMoneyProviderInBody(req);

    console.log("[Gateway][routeInitiateByFlow] raw body", redactSensitive(req.body));

    const flow = resolveTransactionFlow(req.body || {});
    const userId = getUserId(req);

    console.log("[Gateway][routeInitiateByFlow] resolved flow", {
      flow,
      userId,
    });

    if (!userId) {
      const e = new Error("Non autorisé (utilisateur manquant).");
      e.status = 401;
      throw e;
    }

    /**
     * ⚠️ LA CONFIANCE DU NUMÉRO DE DÉPÔT N'EST PLUS CONTRÔLÉE ICI — 2026-09-10.
     *
     * Elle l'est par `middleware/requireTrustedDepositPhone` de TX Core, sur la
     * chaîne de `POST /api/v1/transactions/initiate`. Trois raisons :
     *
     *   1. un contrôle qui AUTORISE un mouvement d'argent doit vivre dans le
     *      service qui déplace l'argent, sinon il suffit de l'atteindre par un
     *      autre chemin pour s'en affranchir (invariant 12) ;
     *   2. la version d'ici interrogeait l'état de vérification par un APPEL
     *      HTTP vers `/api/v1/phone-verification/status` — une route que ce
     *      service ne montait PAS. Elle rendait 404, le `catch` traduisait en
     *      « non vérifié », et le contrôle fonctionnait par accident ;
     *   3. les deux `console.log` qui encadraient l'appel écrivaient sur le
     *      chemin de l'argent à chaque encaissement.
     *
     * Ne pas le réintroduire ici. `test/transactions/edgeHasNoDepositTrust.test.js`
     * échoue si la lecture de confiance revient au bord.
     */

    const bodyWithSecurity = normalizeSecurityFields(req.body || {});
    const provider = getProviderForFlow({
      flow,
      body: bodyWithSecurity,
      canonicalTx: null,
    });
    const serviceUrl = getTargetService(provider);

    console.log("[Gateway][routeInitiateByFlow] provider resolved", {
      flow,
      provider,
      serviceUrl,
      // `bodyWithSecurity` porte la réponse de sécurité — son nom le dit.
      bodyWithSecurity: redactSensitive(bodyWithSecurity),
    });

    if (!serviceUrl) {
      const e = new Error(`Aucun service configuré pour le provider: ${provider}`);
      e.status = 400;
      throw e;
    }

    const strictBody = buildStrictInitiateBody(bodyWithSecurity, flow, provider);

    /**
     * `strictBody` dérive de `bodyWithSecurity` : il porte donc la réponse à la
     * question de sécurité. Les deux journaux la recopiaient — le second sous
     * forme JSON, ce qui la rendait encore plus facile à extraire d'un fichier.
     */
    console.log(
      "[Gateway][routeInitiateByFlow][strictBody]",
      redactSensitive(strictBody)
    );

    if (!strictBody.effectivePricingId) {
      const e = new Error("pricingId ou quoteId requis");
      e.status = 400;
      throw e;
    }

    if (!strictBody.amount || strictBody.amount <= 0) {
      const e = new Error("Montant invalide");
      e.status = 400;
      throw e;
    }

    if (!strictBody.fromCountry || !strictBody.toCountry) {
      const e = new Error("Pays source/destination invalides");
      e.status = 400;
      throw e;
    }

    if (
      flow === TRANSACTION_FLOWS.PAYNOVAL_INTERNAL_TRANSFER &&
      !strictBody.toEmail
    ) {
      const e = new Error("Email du destinataire requis pour un transfert interne");
      e.status = 400;
      throw e;
    }

    req.transactionFlow = flow;
    req.providerSelected = provider;
    req.routedProvider = provider;
    req.body = strictBody;

    console.log("[Gateway][routeInitiateByFlow] dispatching", {
      flow,
      provider,
      serviceUrl,
      endpoint: "/transactions/initiate",
    });

    return await dispatchToProvider({
      req,
      provider,
      serviceUrl,
      endpoint: "/transactions/initiate",
      body: strictBody,
    });
  } catch (err) {
    console.error("[Gateway][routeInitiateByFlow] failed", {
      message: err?.message,
      status: err?.status || err?.response?.status,
      payload: err?.payload,
      responseData: err?.response?.data,
      stack: err?.stack,
      requestBody: req?.body,
    });
    throw err;
  }
}

async function routeActionByFlow(req, action) {
  try {
    /**
     * ⚠️ `routeActionByFlow` traite `confirm` et `cancel`. Le corps d'un
     * `confirm` porte le CODE DE CONFIRMATION. Il était écrit nu.
     *
     * L'ancien motif du test de garde cherchait `req\.body` — avec un point
     * littéral. `req?.body` ne lui correspondait donc PAS : l'écriture en
     * chaînage optionnel traversait la garde sans la déclencher. C'est la
     * deuxième cécité du même test, trouvée en élargissant la première.
     */
    console.log("[Gateway][routeActionByFlow] start", {
      action,
      body: redactSensitive(req?.body),
      params: req?.params,
      query: req?.query,
    });

    const ctx = await resolveRouteContextForAction(req, action);

    /**
     * `ctx.body` sort de `resolveRouteContextForAction`, qui applique
     * `normalizeSecurityFields()` sur un `confirm` : même contenu sensible que
     * ci-dessus, un pas plus loin dans la chaîne.
     */
    console.log("[Gateway][routeActionByFlow] ctx", {
      action,
      flow: ctx.flow,
      provider: ctx.provider,
      serviceUrl: ctx.serviceUrl,
      body: redactSensitive(ctx.body),
    });

    return await dispatchToProvider({
      req,
      provider: ctx.provider,
      serviceUrl: ctx.serviceUrl,
      endpoint: `/transactions/${action}`,
      body: ctx.body,
    });
  } catch (err) {
    console.error("[Gateway][routeActionByFlow] failed", {
      action,
      message: err?.message,
      status: err?.status || err?.response?.status,
      payload: err?.payload,
      responseData: err?.response?.data,
      stack: err?.stack,
    });
    throw err;
  }
}

module.exports = {
  normalizeSecurityFields,
  normalizeCountry,
  normalizeMethod,
  normalizeTxType,
  normalizeRecipientInfo,
  buildStrictInitiateBody,
  getProviderForFlow,
  fetchCanonicalTransaction,
  resolveRouteContextForAction,
  routeInitiateByFlow,
  routeActionByFlow,
};