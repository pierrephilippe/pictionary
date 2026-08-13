# Audit de sécurité — PictioFady

## Synthèse

Cette revue ciblée couvre le client React/TypeScript, le Worker, le Durable Object, le protocole, le service worker et la configuration Cloudflare présents dans le dépôt. Les risques importants identifiés pendant l’audit ont été corrigés dans le code courant ; aucun finding critique ou élevé ne reste ouvert dans le périmètre inspecté. Deux risques moyens restent acceptés pour ce jeu local sans compte — la reprise via `localStorage` et le code de salle utilisé comme capacité d’accès — ainsi que deux sujets faibles de défense en profondeur et de preuve opérationnelle.

Ce résultat n’est ni un test d’intrusion ni une attestation du déploiement. Les bindings, en-têtes et versions réellement actifs doivent être contrôlés sur l’URL de production après chaque livraison.

## Risques importants corrigés pendant l’audit

- Une salle lancée puis abandonnée pouvait prolonger indéfiniment sa durée de vie par ses propres alarmes. L’expiration dépend maintenant de l’activité utilisateur et est vérifiée avant toute transition automatique.
- Une seule session pouvait occuper les 20 WebSockets d’une salle. Une reconnexion remplace désormais le socket précédent de cette session sans consommer une place supplémentaire.
- Les trames binaires, surdimensionnées ou au-delà du quota pouvaient produire une réponse et une persistance répétées. Elles ferment désormais la connexion sans boucle d’amplification.
- Les routes publiques de création, jonction et émission de tickets n’avaient pas de limitation globale. Quatre bindings appliquent maintenant des limites avant le parsing ou l’appel au Durable Object.
- Une course de reconnexion pouvait laisser plusieurs sockets clients actifs et accepter des messages anciens. Chaque tentative possède désormais sa propre génération, et le protocole révisionné refuse les snapshots ou fragments obsolètes.

## Findings ouverts

### SEC-01 — Jeton de session persistant dans `localStorage`

- **Sévérité : moyenne**
- **Emplacement :** [`src/client/session.ts`](src/client/session.ts), fonctions `saveSession` et `loadSession`, lignes 34–54.
- **Preuve :** la structure contenant `code`, `role` et jeton Bearer est sérialisée dans `localStorage`, puis relue au démarrage. Sa forme est validée, mais JavaScript peut toujours lire sa valeur.
- **Impact :** une XSS exécutée sur l’origine, une extension malveillante ou un accès au profil navigateur pourrait voler la session et agir comme contrôleur ou terminal jusqu’à l’expiration de la salle.
- **Correction recommandée :** pour un niveau de sécurité supérieur, déplacer l’identifiant de session dans un cookie `HttpOnly`, `Secure` et adapté au domaine, puis ajouter une stratégie CSRF aux routes mutantes ; une autre option est un jeton en mémoire, au prix de la reprise après fermeture.
- **Mesures actuelles :** jetons aléatoires à forte entropie, portée limitée à une salle, expiration de la salle après inactivité, validation stricte de la valeur relue, CSP restrictive et absence de point d’injection HTML brut repéré.
- **Compromis produit :** le stockage persistant est conservé pour permettre la reprise PWA après mise en arrière-plan ou rechargement.

### SEC-02 — Configuration présente, état du déploiement non attesté

- **Sévérité : faible / assurance opérationnelle**
- **Emplacements :** [`wrangler.jsonc`](wrangler.jsonc), lignes 28–48 et 115–135 ; [`public/_headers`](public/_headers), lignes 1–18 ; [`src/server/worker.ts`](src/server/worker.ts), lignes 14–27 et 106–112.
- **Preuve :** le dépôt configure les rate limiters et les en-têtes, mais aucune capture récente de réponses de production ni export de configuration déployée n’accompagne cette mise à jour documentaire.
- **Impact :** une dérive de configuration, un déploiement incomplet ou une route d’assets non couverte pourrait laisser la production moins protégée que le code revu.
- **Action recommandée :** après déploiement, vérifier CSP, anti-cadrage, `nosniff`, politique de permissions, cache, réponses 429 et `Retry-After` sur l’URL publique ; superviser les 429 avant d’ajuster les seuils.
- **Faux positif possible :** si ces contrôles sont déjà archivés par la CI ou une supervision externe, l’écart est documentaire et non technique.

### SEC-03 — Pas de Trusted Types ni de télémétrie CSP

- **Sévérité : faible / défense en profondeur**
- **Emplacements :** [`public/_headers`](public/_headers), ligne 2 ; [`src/server/worker.ts`](src/server/worker.ts), ligne 15.
- **Preuve :** la CSP interdit les scripts externes, `unsafe-inline` et `unsafe-eval`, mais n’active pas `require-trusted-types-for 'script'` et ne définit aucun mécanisme de rapport CSP.
- **Impact :** une future introduction de sink DOM dangereux serait moins rapidement détectée et ne bénéficierait pas de cette barrière supplémentaire. Aucun sink exploitable n’a été trouvé dans le périmètre actuel, ce qui maintient la sévérité faible.
- **Action recommandée :** avant d’imposer Trusted Types, tester une politique de rapport sur les navigateurs compatibles, centraliser toute politique éventuelle et ne jamais créer de politique qui retourne une chaîne non assainie.

### SEC-04 — Le code de salle donne accès au pool de terminaux

- **Sévérité : moyenne, acceptée sous le modèle de participants de confiance**
- **Emplacements :** [`src/server/room.ts`](src/server/room.ts), méthodes `join`, `issueTicket` et `applyCommand` ; [`src/domain/game.ts`](src/domain/game.ts), fonction `takeDrawingTurn`.
- **Preuve :** toute personne qui connaît le code peut créer une session terminale, dans la limite de 16, et le premier terminal autorisé qui réclame le tour devient celui du dessinateur. Il n’existe ni compte utilisateur ni approbation individuelle du contrôleur.
- **Impact :** si le code est partagé hors du groupe, un tiers peut occuper les emplacements de terminal ou gagner la course d’affectation et voir le mot secret de la manche.
- **Compromis produit :** PictioFady traite le code et le QR comme une invitation destinée aux personnes présentes autour du jeu. Les limites IP, session et WebSocket bornent l’amplification, mais ne transforment pas cette invitation en identité forte.
- **Évolution recommandée si l’exposition change :** ajouter une invitation terminale à usage unique ou une file d’approbation contrôleur, ainsi qu’une liste permettant de révoquer les terminaux. Ne pas présenter le code publiquement dans un contexte non fiable.

## Contrôles présents dans le dépôt

### SEC-10 — En-têtes et rendu React sûrs par défaut

- **Emplacements :** [`public/_headers`](public/_headers), lignes 1–18 ; [`src/server/worker.ts`](src/server/worker.ts), lignes 14–27 et 106–112.
- CSP limitée à l’origine, `frame-ancestors 'none'`, `object-src 'none'`, anti-cadrage, `nosniff`, politique de référent et politique de permissions sont configurés pour les assets et les réponses API.
- La recherche ciblée n’a trouvé ni `dangerouslySetInnerHTML`, ni sink `innerHTML`/`document.write`, ni `eval`/`new Function`, ni script distant chargé par l’application.
- Les noms de joueurs, erreurs et autres valeurs réseau sont rendus par interpolation JSX, donc échappés par React.

### SEC-11 — Validation et bornes des entrées

- **Emplacements :** [`src/server/worker.ts`](src/server/worker.ts), lignes 67–101 ; [`src/shared/protocol.ts`](src/shared/protocol.ts), lignes 4–111 ; [`src/server/room.ts`](src/server/room.ts), lignes 185–215.
- Les routes exigent du JSON, lisent au plus 4 KiB et valident des objets Zod stricts.
- Les commandes WebSocket et les messages serveur ont un schéma d’exécution partagé. Une trame binaire ou dépassant 24 000 octets ferme le socket avec le code 1009.
- Les fragments sont bornés à 96 points ; le moteur borne aussi chaque trait à 1 024 points, chaque tour à 240 traits et 8 000 points.

### SEC-12 — Authentification éphémère et autorisation serveur

- **Emplacements :** [`src/server/worker.ts`](src/server/worker.ts), lignes 98–101 et 163–187 ; [`src/server/room.ts`](src/server/room.ts), lignes 134–182 et 269–337.
- Les sessions utilisent des jetons aléatoires. La demande de ticket exige un Bearer conforme ; le ticket WebSocket est à usage unique et expire après 60 secondes.
- Une origine WebSocket différente est refusée lorsqu’un en-tête `Origin` est fourni. Le ticket reste obligatoire même pour un client non navigateur qui omet cet en-tête.
- Le Durable Object vérifie les rôles, le terminal affecté et l’identifiant du tour pour chaque commande sensible. Le mot secret n’est inclus que dans le snapshot du terminal dessinateur actif.
- Une nouvelle connexion de la même session ferme l’ancienne, ce qui réduit les doubles soumissions concurrentes.

### SEC-13 — Limitation de débit à deux niveaux

- **Emplacements :** [`wrangler.jsonc`](wrangler.jsonc), lignes 28–48 ; [`src/server/worker.ts`](src/server/worker.ts), lignes 32–50 et 121–178 ; [`src/server/room.ts`](src/server/room.ts), lignes 41–47, 185–215 et 512–525.
- Les bindings demandent 5 créations et 40 tentatives de rejoindre par minute et par IP, ainsi que 120 demandes de ticket par minute et par IP.
- Une clé dérivée du hash du jeton limite chaque session à 12 tickets par minute sans placer le jeton brut dans la clé.
- Sans `CF-Connecting-IP`, les requêtes partagent volontairement une clé restrictive `missing-ip`.
- Chaque session accepte au plus 40 trames WebSocket par seconde. Les commandes mal formées ou refusées sont comptées ; le dépassement ferme le socket avec le code 1008 sans boucle d’erreur.

Les bindings Cloudflare appliquent une politique de protection et non un quota transactionnel destiné à la facturation. Leurs seuils doivent être ajustés avec les données de production, en tenant compte des réseaux partagés et des reconnexions mobiles.

### SEC-14 — Intégrité de l’état temps réel

- **Emplacements :** [`src/server/room.ts`](src/server/room.ts), lignes 261–393 et 500–509 ; [`src/client/room-state.ts`](src/client/room-state.ts), lignes 9–70 ; [`src/shared/protocol.ts`](src/shared/protocol.ts), lignes 75–111.
- Toute persistance incrémente une révision globale. Les deltas portent `revision`, `turnId`, `canvasRevision` et `offset`.
- Le client ignore les snapshots plus anciens et les duplicatas cohérents. Un trou d’offset dans un trait, un tour différent ou une époque de canevas différente déclenche une resynchronisation ; la révision globale peut légitimement sauter lorsque d’autres états persistants changent.
- Annuler, rétablir et effacer changent l’époque du canevas ; le moteur refuse ensuite un fragment retardé de l’époque précédente.
- La file de commandes du Durable Object maintient l’ordre mutation–persistance–diffusion. `safeSend` isole un socket qui échoue.
- Le démarrage applique les réglages de manière atomique et la résolution d’un tour déjà terminé est refusée, ce qui empêche les doubles points.

### SEC-15 — Cycle de vie du stockage

- **Emplacements :** [`src/server/room.ts`](src/server/room.ts), lignes 73–146, 233–258 et 453–537.
- Le constructeur lit l’existence de la table sans la créer. Seule la création explicite d’une salle initialise `room_state` ; rejoindre un code inconnu retourne 404 sans table métier.
- L’état version 1 est migré vers la version 2, avec retrait de l’ancien réglage de thème et ajout des révisions et dates d’activité.
- L’expiration de deux heures est calculée depuis la dernière activité et vérifiée avant les transitions métier. L’alarme suivante est le minimum entre expiration et échéance de phase.

### SEC-16 — Cache PWA et chaîne de livraison

- **Emplacements :** [`public/sw.js`](public/sw.js), lignes 1–60 ; [`.github/workflows/deploy-production.yml`](.github/workflows/deploy-production.yml), lignes 21–44.
- Le service worker ignore les requêtes non GET, les autres origines et toutes les routes `/api/`. Il ne met donc pas en cache les snapshots, jetons ou réponses API.
- Les caches sont versionnés et les anciens sont supprimés à l’activation ; une mise à jour attend l’action explicite de l’utilisateur.
- La CI utilise `npm ci`, lance un audit de dépendances de production au seuil modéré, exécute `npm run check`, puis déploie avec des secrets GitHub. La présence de ces étapes ne remplace pas l’examen de leur dernier résultat.

## Vérifications automatisées associées

Les tests du dépôt couvrent les schémas stricts, les corps volumineux, les en-têtes API, l’origine WebSocket, les limites HTTP, les commandes invalides comptabilisées, les trames binaires/surdimensionnées, l’isolation du mot, les rôles, les doubles validations, les révisions/deltas, le remplacement de socket, la migration et l’expiration. Le nombre de tests n’est pas figé dans ce rapport ; la sortie de la suite sur le commit audité est la référence.

Restent hors de cette preuve automatisée : l’état exact de Cloudflare en production, un test d’intrusion, une analyse dynamique XSS dans un navigateur, la sécurité des extensions installées sur les téléphones, la compromission du compte Cloudflare/GitHub et le comportement des limites sous charge distribuée réelle.
