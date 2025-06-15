# PayNoval Microservices

Architecture **microservices** pour la gestion sécurisée et scalable des transactions financières (PayNoval, banque, Stripe, mobile money).

## ⚡️ Composants

- **API Gateway** : Sécurité centrale, validation, et routage intelligent vers le bon service selon le type de transaction
- **Service PayNoVal** : Transferts internes PayNoval↔PayNoval
- **Service Stripe** : Paiements par carte bancaire (via Stripe)
- **Service Banque** : Virements bancaires classiques
- **Service MobileMoney** : Transactions par opérateur mobile money (Orange, MTN, Wave, Moov.)

## 🚀 Démarrage local

1. **Copie chaque `.env.example` en `.env` dans chaque dossier** (gateway et microservices), puis complète les clés/token/URLs.
2. **Lance chaque service dans un terminal séparé :**

```bash
# Gateway (API centrale)
cd api-gateway/
npm install && npm start

# Service PayNoVal
cd ../service-paynoval/
npm install && npm start

# Service Stripe
cd ../service-stripe/
npm install && npm start

# Service Banque
cd ../service-bank/
npm install && npm start

# Service MobileMoney
cd ../service-mobilemoney/
npm install && npm start
