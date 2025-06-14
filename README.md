# PayNoval Microservices

Cette architecture regroupe plusieurs microservices pour gérer les transactions :

- **API Gateway** : routage selon `funds`/`destination`
- **Service PayNoVal** : flux interne PayNoVal→PayNoVal
- **Service Stripe**  : paiements carte via Stripe
- **Service Banque**  : virements bancaires
- **Service MobileMoney** : paiements Mobile Money

## Démarrage local

1. Copier les `.env.example` en `.env` dans chaque dossier et renseigner les clés
2. Lancer chaque service :

```bash
# Dans api-gateway/
npm install && npm start
# Dans service-paynoval/
npm install && npm start
# etc.