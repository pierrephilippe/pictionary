# État qualité — PictioFady

## Portée des preuves

Ce document décrit l’implémentation présente dans le dépôt et les contrôles automatisés associés. La mise à jour documentaire n’a pas relancé un parcours navigateur, Lighthouse ou un essai sur plexiglas. Les comportements visuels et matériels sont donc distingués des garanties couvertes par le code et les tests.

Les anciens chiffres de bundle, LCP, CLS, scores Lighthouse et le précédent parcours « navigateur réel » ne sont plus présentés comme résultats actuels : l’interface, le protocole et les modules client ont changé depuis ces mesures. Ils doivent être recalculés sur le build final avant toute publication de performance.

## Commandes de référence

```bash
npm run check
npm audit --omit=dev --audit-level=moderate
```

`npm run check` génère les types Wrangler, vérifie TypeScript, construit avec Vite puis exécute tous les fichiers `tests/**/*.test.ts`. Le nombre exact de tests n’est volontairement pas dupliqué ici : la sortie Vitest du commit vérifié fait foi. L’audit de dépendances est aussi exécuté par le workflow de production, mais sa configuration ne prouve pas à elle seule le résultat d’une exécution future.

## Exigences UX/UI reflétées par le code

| Exigence | Implémentation actuelle | Niveau de preuve |
| --- | --- | --- |
| Choix initial clair | Deux zones égales ; sur mobile, deux lignes de `50dvh`, création puis jonction. | CSS et composants ; contrôle visuel multi-appareils requis. |
| Paramétrage sans ambiguïté | Difficulté, durée et nombre de manches uniquement ; l’action finale est « Lancer avec ces réglages », sans sauvegarde intermédiaire. | Composant et schéma de protocole. |
| Jonction rapide | Six cases, majuscules et filtrage des caractères ambigus ; envoi automatique au sixième caractère. | Normalisation testée ; clavier, collage et focus à vérifier en navigateur. |
| Lien et QR directs | Le contrôleur encode `/?join=CODE` dans le lien copié et dans le QR ; l’accueil lit ce paramètre et tente la jonction. | Lecture statique ; scan physique non automatisé. |
| Dessin simple | Canevas principal, menu d’outils repliable, mot et minuteur visibles, sélection du gagnant séparée. La sélection interrompt la manche; au timeout, la toile est figée jusqu’à la décision obligatoire du dessinateur. Le gagnant devient le prochain dessinateur, tandis que « Aucun gagnant » déclenche un tirage au sort serveur. | Règles et composants testés hors DOM ; ergonomie tactile à tester. |
| Projection épurée | Pendant `drawing`, les informations de jeu sont masquées et seule la toile est rendue ; une barre technique temporaire apparaît après interaction. En cas de coupure, une alerte de reprise remplace explicitement l’image figée. Pyramide requiert portrait, V/plaque paysage; l’application demande leur verrouillage et bloque le rendu tant que l’orientation est incorrecte. | Branche de rendu et fonctions d’orientation testées ; APIs navigateur et projection physique à vérifier. |
| Sens du reflet | Chaque copie reçoit une pré-inversion `scaleX(-1)` avant sa rotation. | CSS vérifiable ; résultat optique à confirmer sur le support réel. |
| Accessibilité de base | Libellés, états `aria`, annonces de connexion, pièges de focus des panneaux, cibles d’au moins 44 px et réduction des animations. | Inspection du code ; audit clavier, lecteur d’écran et contraste à refaire. |

La perception « moderne, sobre, fun et désirable » reste un critère qualitatif. Elle ne peut pas être déclarée validée sans sessions d’observation avec des joueurs, idéalement sur une partie complète et dans les conditions lumineuses de projection visées.

## Architecture actuelle

| Responsabilité | Module principal |
| --- | --- |
| Règles, phases, scores, mots et limites de dessin | `src/domain/game.ts`, `src/domain/types.ts`, `src/domain/catalogue.ts` |
| Contrat réseau validé à l’exécution | `src/shared/protocol.ts` |
| HTTP, en-têtes, corps bornés et rate limiting | `src/server/worker.ts` |
| État autoritaire, SQLite, alarmes et WebSockets | `src/server/room.ts` |
| Session locale, code et URL | `src/client/session.ts` |
| Cycle ticket/WebSocket et reconnexion | `src/client/useRoomConnection.ts` |
| Réduction des snapshots et deltas | `src/client/room-state.ts` |
| Rendu de trait et canevas | `src/client/drawing/model.ts`, `src/client/drawing/DrawingCanvas.tsx` |
| Composition des écrans et interactions | `src/client/App.tsx` |

Ce découpage retire du composant principal les responsabilités réseau, session, réduction temps réel et rendu de canevas. `DrawingBoard` demeure dans `App.tsx` : il orchestre encore les gestes, le découpage des fragments, le menu et la résolution de manche. C’est une limite de taille connue, pas une duplication du moteur de rendu.

## Cohérence temps réel

- `start_game` transporte les réglages et les applique dans la même mutation autoritaire ; il n’existe plus d’état « réglages enregistrés mais partie non lancée ».
- Chaque persistance incrémente `RoomState.revision`, reproduite dans les snapshots. Les messages serveur sont validés avec Zod avant réduction côté client.
- Un `stroke_delta` contient la révision globale, l’identifiant du tour, la révision du canevas et l’offset exact du fragment. Le client ignore un duplicata cohérent et force une reconnexion lorsqu’un fragment manque ou appartient à une autre époque.
- Annuler, rétablir et effacer incrémentent `canvasRevision`. Un fragment retardé portant l’ancienne valeur est refusé par le moteur.
- Le hook de connexion annule les demandes de ticket obsolètes, associe les callbacks à une génération de session, ferme ses candidats au démontage et applique un délai exponentiel avec gigue.
- Le Durable Object remplace l’ancien WebSocket d’une session, sérialise les commandes reçues, persiste avant diffusion et isole une erreur d’envoi au socket concerné.
- La salle expire selon `lastActivityAt`. Avant une transition d’alarme, l’expiration est vérifiée ; la prochaine alarme est le minimum entre l’échéance métier et l’expiration.

## Couverture automatisée disponible

La suite existante couvre notamment :

- catalogue, réglages atomiques, transitions, confidentialité du mot, score unique et limites de toile dans `tests/game.test.ts` ;
- validation HTTP/WebSocket, rôles, migration d’état, expiration, deltas, limite de terminaux, remplacement de socket et tailles de trames dans `tests/room.test.ts` ;
- clés et seuils des bindings HTTP dans `tests/rate-limit.test.ts` ;
- ordre, duplicata, trous de fragments et validation imbriquée des messages dans `tests/room-state.test.ts` ;
- normalisation et longueur du code dans `tests/session.test.ts` ;
- décision entre peinture incrémentale et reconstruction du canevas dans `tests/drawing.test.ts`.
- correspondance support/orientation, repli du verrouillage et persistance du support dans `tests/projection.test.ts`.

Cette couverture ne constitue pas un test de bout en bout de l’interface. Elle ne simule pas les Pointer Events complets du `DrawingBoard`, le collage/focus des six cases, le QR réel, les API Fullscreen/Orientation/Wake Lock, le service worker dans un navigateur ni la réflexion optique.

Le Wake Lock est demandé au montage de la projection puis redemandé au retour de la page au premier plan lorsqu’il a été libéré. Cette logique reste une amélioration optionnelle : son comportement dépend du navigateur et du système et doit être confirmé sur l’appareil cible.

## Sécurité et exploitation

Le rapport détaillé se trouve dans [`security_best_practices_report.md`](../security_best_practices_report.md). Le dépôt contient une CSP restrictive, une validation stricte, des limites de taille et de débit, des autorisations serveur et un cache PWA qui exclut `/api/`. La configuration présente n’est toutefois pas une preuve que les en-têtes et bindings actifs en production correspondent au commit : ils doivent être vérifiés après déploiement.

## Plan de validation avant mise en production

1. Exécuter `npm run check` puis l’audit de dépendances sur le commit destiné au déploiement et archiver les sorties CI.
2. Démarrer le Worker local complet, pas seulement Vite, puis effectuer création, jonction directe, partie à un joueur et partie multi-terminaux.
3. Tester saisie, collage, retour arrière et soumission automatique du code sur Safari iOS et Chrome Android.
4. Simuler perte réseau, changement d’onglet et reconnexion avant/après `clear`, entre deux fragments et à une transition de manche.
5. Projeter sur pyramide, V et plaque afin de confirmer orientation, pré-inversion, cadrage, luminosité et absence d’informations pendant le dessin.
6. Refaire Lighthouse, Core Web Vitals et analyse du bundle sur le build final ; consigner l’appareil, le navigateur, le profil réseau et la date.
7. Vérifier sur l’URL déployée les en-têtes, le `Retry-After`, les réponses 429 et l’absence de mise en cache des API.
