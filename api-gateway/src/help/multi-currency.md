# Multi-currency (PayNoval) — Règle définitive

## Objectif
Éviter les bugs où un même montant s’affiche avec une mauvaise devise (ex: `75,46` affiché `F CFA` au lieu de `€`).

## Interdiction
Ne plus stocker ni utiliser des "symboles/labels" comme devise :
- ❌ "€"
- ❌ "F CFA"
- ❌ "$CAD"

On ne doit stocker et transporter que des codes ISO :
- ✅ EUR
- ✅ XOF
- ✅ XAF
- ✅ CAD
- ✅ USD

## Champs ajoutés (Transaction)
Chaque transaction peut avoir deux côtés :

### 1) Côté source (expéditeur / payer)
- `amountSource`
- `currencySource` (ISO)
- `feeSource` (frais côté expéditeur)

### 2) Côté target (destinataire / reçu)
- `amountTarget`
- `currencyTarget` (ISO)

### 3) Taux
- `fxRateSourceToTarget`

## Objet `money` (pour le Frontend)
Le Gateway renvoie un objet stable :
```json
"money": {
  "source": { "amount": 50000, "currency": "XOF" },
  "feeSource": { "amount": 500, "currency": "XOF" },
  "target": { "amount": 75.46, "currency": "EUR" },
  "fxRateSourceToTarget": 0.00152447
}
