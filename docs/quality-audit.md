# Audit qualité — PictioFady

## Périmètre et méthode

Audit local effectué sur le build de production, le Worker/Durable Object local et un viewport mobile iPhone 13. Il complète les tests automatisés ; il ne remplace pas les essais physiques avec le plexiglas et un vrai réseau mobile.

## Résultats vérifiés

| Domaine | Résultat |
| --- | --- |
| Build | TypeScript et Vite passent ; le bundle applicatif initial fait 233,3 ko (72,9 ko gzip). Le module QR code est chargé à la demande et ajoute 16,7 ko (6,3 ko gzip) seulement à la création de salle. |
| Tests | `npm run check` passe : 3 fichiers et 22 tests. |
| Chargement mobile | Mesure locale synthétique Fast 4G / CPU ×4, écran d’accueil sans session : LCP 298 ms et CLS 0. La CSS bloque le rendu environ 7 ms, sans économie estimée. |
| Accessibilité | Lighthouse mobile : 100/100 accessibilité, bonnes pratiques, SEO et navigation agentique ; 44 contrôles réussis, aucune alerte console. |
| PWA | Manifest, icône, service worker, écran hors-ligne, mise à jour explicite et reprise de session sont présents. Un rechargement navigateur en mode hors-ligne a restauré le shell sans erreur console ; le cache exclut les API et WebSockets. |
| En-têtes | En local, HTML, assets, service worker et API exposent CSP, anti-cadrage, `nosniff`, politique de permissions et cache adapté. |
| Parcours mobile | Création de salle, deux joueurs, deux terminaux isolés, passage du terminal au dessinateur, mot secret isolé, premier trait, attribution directe du point et scores vérifiés dans un navigateur réel. La projection a été contrôlée en 4 vues (pyramide), 2 vues (V) et 1 vue (plaque), avec réglages accessibles sans quitter la partie et plein écran immersif actif. |

## Audit UX/UI et jouabilité

- La page d’accueil explique la séquence en trois étapes et sépare nettement la création de salle du terminal de dessin.
- Les cibles principales sont de vrais boutons avec noms accessibles ; les formulaires ont des libellés et les changements de connexion sont annoncés.
- Le dessinateur voit les commandes de trait, annuler/rétablir, gomme, effacement confirmé et un choix explicite du gagnant. Il peut aussi déclarer qu’il n’y a pas de gagnant.
- La projection masque le mot pendant le tour, affiche la progression, le minuteur, les scores et quatre/deux/une copie selon le support. Les réglages restent disponibles sans abandonner la salle.
- Le terminal peut devenir projecteur ou revenir au dessin hors tour actif ; la salle peut jouer avec un seul joueur.

## Architecture et temps réel

- Le domaine est séparé du client et du Worker. Le Durable Object reste autoritaire pour l’état, les délais, les points et les traits persistés.
- Les commandes et les charges de dessin sont validées avec des schémas stricts avant l’exécution. Les traits sont normalisés et diffusés en delta ; un snapshot permet la restauration après reconnexion.
- La reconnexion client applique un délai exponentiel avec gigue et reprend lors du retour réseau ou de la visibilité de la page.
- Chaque session est limitée à 40 commandes WebSocket par seconde, y compris les commandes invalides ; le compteur est persisté afin de survivre à l’hibernation.

## Audit sécurité

Le détail et les références de code sont dans [`security_best_practices_report.md`](../security_best_practices_report.md). Aucun problème critique ou élevé n’est identifié dans le périmètre revu et `npm audit --omit=dev --audit-level=high` ne remonte aucune vulnérabilité de production. Les points restant à gérer au déploiement sont une règle Cloudflare de limitation globale sur la création/rejoint de salles et l’acceptation du compromis de jeton éphémère conservé en `localStorage` pour la reprise PWA.

## Limites et essais physiques restants

1. Safari iOS ne garantit ni Fullscreen API document ni verrouillage d’orientation. L’interface garde un mode immersif CSS et une indication de rotation, mais ce comportement doit être validé sur l’iPhone cible.
2. Le `Wake Lock` est volontairement une amélioration optionnelle : vérifier son renouvellement après mise en arrière-plan sur Chrome Android.
3. Les rotations des faces représentent les géométries attendues des supports ; l’alignement final dépend du plexiglas, de la taille d’écran et de la distance. Utiliser la mire de calibration sur chaque support physique.
4. Les mesures de chargement locales n’incluent pas la latence d’un réseau mobile réel ni le temps de réveil d’un Durable Object. Vérifier la première connexion et les reconnexions sur 4G/5G avant mise en production.
