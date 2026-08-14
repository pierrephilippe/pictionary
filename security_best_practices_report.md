# Audit de sécurité — PictioFady

## Synthèse

Cette revue ciblée couvre le client React/TypeScript, le Worker, le Durable Object, le protocole, le service worker et la configuration Cloudflare présents dans le dépôt. Aucun finding critique n'a été découvert. Le code courant corrige la faille de transport HTTP observée en production, mais l'URL publique reste vulnérable jusqu'au prochain déploiement et à sa vérification. Trois risques moyens restent ouverts : la reprise via `localStorage`, le code de salle utilisé comme capacité d'accès et l'amplification de persistance/diffusion par commandes WebSocket.

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

### SEC-02 — HTTP encore accepté sur le déploiement audité

- **Sévérité : élevée sur la production observée ; corrigée dans le dépôt, déploiement requis.**
- **Emplacements :** [`wrangler.jsonc`](wrangler.jsonc), bloc `assets` ; [`public/_headers`](public/_headers), lignes 1–8 ; [`src/server/worker.ts`](src/server/worker.ts), fonctions `productionHttpsRedirect`, `json` et `secureAssetResponse`.
- **Preuve :** le 14 août 2026, `http://pictionary.fady.eu/` et `http://pictionary.fady.eu/api/health` répondaient `200 OK` sans redirection ; les réponses HTTPS n'envoyaient pas `Strict-Transport-Security`.
- **Impact :** un attaquant présent sur le réseau peut injecter le JavaScript initial, voler le Bearer persistant puis contrôler ou supprimer une salle. Depuis HTTP, fetch, WebSocket et QR restent également non chiffrés.
- **Cause racine :** les assets statiques pouvaient être servis avant le Worker et aucune règle edge ne forçait HTTPS.
- **Correction dans le dépôt :** `run_worker_first: true`, redirection 308 en production avec conservation du chemin et de la requête, et HSTS `max-age=31536000` sur API et assets. `includeSubDomains` et `preload` ne sont volontairement pas activés sans audit de tous les sous-domaines.
- **Action requise :** déployer ce commit, activer aussi « Always Use HTTPS » ou une Redirect Rule au niveau de la zone, puis vérifier HTTP `/`, `/api/health` et assets ainsi que HSTS sur HTTPS.
- **Test associé :** `tests/room.test.ts` couvre la fonction de redirection, l'URL cible, le mode développement et HSTS API ; seul un contrôle post-déploiement prouve le comportement edge.

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
- **Évolution recommandée si l'exposition change :** ajouter une invitation terminale à usage unique ou une file d'approbation contrôleur, ainsi qu'une liste permettant de révoquer les terminaux. Ne pas présenter le code publiquement dans un contexte non fiable.

### SEC-05 — Amplification WebSocket, SQLite et diffusion

- **Sévérité : moyenne**
- **Emplacements :** [`src/server/room.ts`](src/server/room.ts), gestion d'erreur de `webSocketMessage`, `applyCommand`, `broadcast` et `persist` ; [`src/domain/game.ts`](src/domain/game.ts), `setTerminalDisplayMode`.
- **Preuve :** une commande refusée persiste le compteur dans le document complet. Une commande valide répétant le même mode est aussi considérée comme une mutation, actualise l'activité, réécrit l'état puis diffuse un snapshot complet à tous les sockets.
- **Reproduction :** avec une session terminale, envoyer 39 commandes invalides ou `set_display_mode: drawing` identiques par seconde, juste sous la limite de 40.
- **Impact :** amplification CPU, SQLite et bande passante à l'échelle d'une salle, surtout avec un canevas proche de 8 000 points et de nombreux sockets.
- **Cause racine :** budget unique pour traits et contrôles, compteur anti-abus inclus dans le gros état métier, absence de no-op et snapshot global par défaut.
- **Correction recommandée :** budgets séparés, quelques strikes puis fermeture 1008, compteur léger hors `RoomState`, détection stricte de no-op et diffusion ciblée. À terme, persister les fragments de trait en append plutôt que remplacer tout le JSON.
- **Test recommandé :** instrumenter écritures et `send`; une rafale de no-op/refus ne doit ni incrémenter chaque révision ni diffuser chaque fois le canevas.

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
- Les états version 1 et 2 sont normalisés vers la version 3, avec difficulté singulière, retrait de l'ancien réglage de thème, révisions et dates d'activité.
- L'expiration de deux heures est calculée depuis la dernière activité et vérifiée avant les transitions métier. L'alarme suivante est le minimum entre expiration et échéance de phase.
- **Limite ouverte :** le JSON persistant n'est pas encore validé par un schéma par version et une version future n'est pas rejetée avant mutation ; un rollback pourrait donc réécrire un état incompatible. Ajouter des migrations pures et un refus sans écriture pour `version > 3`.

### SEC-16 — Cache PWA et chaîne de livraison

- **Emplacements :** [`public/sw.js`](public/sw.js), lignes 1–60 ; [`.github/workflows/deploy-production.yml`](.github/workflows/deploy-production.yml), lignes 21–44.
- Le service worker ignore les requêtes non GET, les autres origines et toutes les routes `/api/`. Il ne met donc pas en cache les snapshots, jetons ou réponses API.
- Les caches sont versionnés et les anciens sont supprimés à l’activation ; une mise à jour attend l’action explicite de l’utilisateur.
- La CI utilise `npm ci`, lance un audit de dépendances de production au seuil modéré, exécute `npm run check`, puis déploie avec des secrets GitHub. La présence de ces étapes ne remplace pas l’examen de leur dernier résultat.

## Vérifications automatisées associées

Les tests du dépôt couvrent les schémas stricts, les corps volumineux, les en-têtes API, l’origine WebSocket, les limites HTTP, les commandes invalides comptabilisées, les trames binaires/surdimensionnées, l’isolation du mot, les rôles, les doubles validations, les révisions/deltas, le remplacement de socket, la migration et l’expiration. Le nombre de tests n’est pas figé dans ce rapport ; la sortie de la suite sur le commit audité est la référence.

Restent hors de cette preuve automatisée : l’état exact de Cloudflare en production, un test d’intrusion, une analyse dynamique XSS dans un navigateur, la sécurité des extensions installées sur les téléphones, la compromission du compte Cloudflare/GitHub et le comportement des limites sous charge distribuée réelle.
