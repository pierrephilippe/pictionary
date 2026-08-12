# Audit de sécurité — PictioFady

## Synthèse

Aucune vulnérabilité critique ou élevée n’a été identifiée dans le périmètre React, Worker et Durable Object revu. Les protections de l’enveloppe PWA, la validation des entrées et le contrôle de cadence ont été renforcés. Deux mesures de défense en profondeur restent à configurer ou à accepter avant une exposition publique large.

## Correctifs appliqués

### SEC-01 — En-têtes de sécurité sur l’application statique

- **Sévérité avant correction : moyenne**
- **Emplacements :** [`public/_headers`](public/_headers) lignes 1–18 et [`src/server/worker.ts`](src/server/worker.ts) lignes 13–26
- **Constat :** les assets Cloudflare étaient servis avant le Worker ; les en-têtes ajoutés dans `src/server/worker.ts` ne couvraient donc pas le document HTML, le manifest et les bundles.
- **Correction :** CSP restrictive, `frame-ancestors 'none'`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` et `Permissions-Policy` sont maintenant appliqués aux assets. Les réponses `/api/` conservent les mêmes protections dans le Worker.

### SEC-02 — Validation stricte des entrées HTTP et WebSocket

- **Sévérité avant correction : moyenne**
- **Emplacements :** [`src/server/worker.ts`](src/server/worker.ts) lignes 45–74, [`src/shared/protocol.ts`](src/shared/protocol.ts) lignes 4–46 et [`src/server/room.ts`](src/server/room.ts) lignes 167–194
- **Constat :** des champs inattendus pouvaient être ignorés par le protocole et le Worker lisait le JSON sans limite explicite de taille.
- **Correction :** le JSON HTTP est borné à 4 KiB ; les requêtes et commandes sont des schémas Zod stricts ; les erreurs de validation restent génériques côté WebSocket. Les tests couvrent les charges trop volumineuses et les champs inattendus.

### SEC-03 — Cadence des commandes WebSocket

- **Sévérité avant correction : moyenne**
- **Emplacements :** [`src/server/room.ts`](src/server/room.ts) lignes 179–193 et 420–442, [`src/domain/types.ts`](src/domain/types.ts) lignes 49–58
- **Constat :** les limites de taille et de points protégeaient le dessin, mais pas une rafale de commandes légères (annuler, rétablir, etc.).
- **Correction :** chaque session est limitée à 40 commandes par seconde dans le Durable Object, avec état persistant au-delà de l’hibernation.

## Risques résiduels à accepter ou traiter au déploiement

### SEC-04 — Jeton de salle dans `localStorage`

- **Sévérité : faible**
- **Emplacement :** [`src/client/App.tsx`](src/client/App.tsx) lignes 51–92
- **Impact :** une XSS sur cette origine pourrait lire le jeton opaque de la salle active. Le jeton n’est valable que pour une salle éphémère et la CSP réduit fortement ce risque, mais il reste lisible par JavaScript pour permettre la reprise PWA.
- **Compromis :** le stockage persistant est conservé afin que la projection reconnecte après mise en arrière-plan. Une migration vers un cookie `HttpOnly` demanderait une stratégie CSRF et modifierait le protocole sans compte du MVP.

### SEC-05 — Protection anti-abus de l’API publique

- **Sévérité : faible à moyenne selon l’exposition**
- **Emplacement :** configuration Cloudflare hors dépôt ; les routes concernées sont définies dans [`src/server/worker.ts`](src/server/worker.ts) lignes 100–126.
- **Impact :** un acteur externe peut créer de nombreuses salles ou tenter de nombreuses connexions avant les limites par salle. Le Durable Object protège chaque salle, mais ne peut pas imposer une limite globale sans stockage ou règle périphérique.
- **Action recommandée :** ajouter dans Cloudflare une règle de rate limiting/WAF sur `POST /api/rooms` et `POST /api/rooms/*/join`, adaptée au trafic réel. Ne pas appliquer de CAPTCHA au MVP sans signal d’abus afin de préserver l’entrée en jeu.

## Vérifications effectuées

- Aucun `dangerouslySetInnerHTML`, `eval`, script tiers ou navigation contrôlée par entrée utilisateur n’est présent dans le périmètre revu.
- Les snapshots ne délivrent le mot secret qu’au terminal dessinateur actif ([`src/domain/game.ts`](src/domain/game.ts) lignes 363–396) ; ce comportement est couvert par les tests de moteur et Durable Object.
- Les tests Worker confirment l’autorisation par rôle, l’isolation du mot, la validation des gagnants, la limite de terminaux, la validation stricte des entrées et la limite des commandes refusées ([`tests/room.test.ts`](tests/room.test.ts) lignes 65–125).
- `npm audit --omit=dev --audit-level=high` a été exécuté le 12 août 2026 : aucune vulnérabilité connue dans les dépendances de production.
