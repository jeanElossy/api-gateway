"use strict";

/**
 * Flows métier canoniques du gateway.
 * Le flow décrit la nature métier de la transaction.
 * Le provider n'est qu'un détail d'exécution.
 */

const TRANSACTION_FLOWS = Object.freeze({
  PAYNOVAL_INTERNAL_TRANSFER: "PAYNOVAL_INTERNAL_TRANSFER",

  MOBILEMONEY_COLLECTION_TO_PAYNOVAL: "MOBILEMONEY_COLLECTION_TO_PAYNOVAL",
  PAYNOVAL_TO_MOBILEMONEY_PAYOUT: "PAYNOVAL_TO_MOBILEMONEY_PAYOUT",

  CARD_TOPUP_TO_PAYNOVAL: "CARD_TOPUP_TO_PAYNOVAL",
  PAYNOVAL_TO_CARD_PAYOUT: "PAYNOVAL_TO_CARD_PAYOUT",

  // Pas de flux bancaire : le rail a été retiré le 2026-08-26 (§1).
  // PayNoval opère sur trois rails — interne, mobile money, cartes.

  UNKNOWN_FLOW: "UNKNOWN_FLOW",
});

const FLOW_TO_DEFAULT_PROVIDER = Object.freeze({
  [TRANSACTION_FLOWS.PAYNOVAL_INTERNAL_TRANSFER]: "paynoval",

  [TRANSACTION_FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL]: "mobilemoney",
  [TRANSACTION_FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT]: "mobilemoney",

  /**
   * ⚠️ Valait « stripe » — un rail RETIRÉ du périmètre le 2026-09-08, dont
   * l'adapter a été supprimé. Le dépôt par carte pointait donc, depuis la
   * passerelle, vers un prestataire que plus rien ne sert : la requête partait,
   * la transaction se créait, et le règlement était impossible.
   *
   * Même faute que celle corrigée côté Tx Core le 2026-09-08 : supprimer un
   * prestataire ne consiste pas à supprimer son fichier, mais à s'assurer que
   * plus rien ne le NOMME comme repli.
   */
  [TRANSACTION_FLOWS.CARD_TOPUP_TO_PAYNOVAL]: "visa_direct",
  [TRANSACTION_FLOWS.PAYNOVAL_TO_CARD_PAYOUT]: "visa_direct",


  [TRANSACTION_FLOWS.UNKNOWN_FLOW]: "paynoval",
});

function isKnownTransactionFlow(flow) {
  return Object.values(TRANSACTION_FLOWS).includes(String(flow || ""));
}

function getDefaultProviderForFlow(flow) {
  return FLOW_TO_DEFAULT_PROVIDER[flow] || "paynoval";
}

function isExternalPayoutFlow(flow) {
  return [
    TRANSACTION_FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT,
    TRANSACTION_FLOWS.PAYNOVAL_TO_CARD_PAYOUT,
  ].includes(flow);
}

function isExternalCollectionFlow(flow) {
  return [
    TRANSACTION_FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL,
    TRANSACTION_FLOWS.CARD_TOPUP_TO_PAYNOVAL,
  ].includes(flow);
}

module.exports = {
  TRANSACTION_FLOWS,
  FLOW_TO_DEFAULT_PROVIDER,
  isKnownTransactionFlow,
  getDefaultProviderForFlow,
  isExternalPayoutFlow,
  isExternalCollectionFlow,
};