# PictioFady — Pictionary holographique

PictioFady est une PWA multijoueur conçue pour une projection de type Pepper’s ghost. Le téléphone qui crée la salle inscrit les joueurs puis devient le projecteur au lancement ; les autres téléphones sont des terminaux interchangeables que l’on donne au dessinateur de la manche.

L’interface peut être installée et son enveloppe statique reste disponible hors ligne. Une connexion demeure nécessaire pendant la partie : le Durable Object est l’autorité pour le mot secret, les délais, les scores et le dessin.

## Parcours utilisateur actuel

- L'accueil et les écrans applicatifs hors dessin occupent deux moitiés de 50 % du viewport : superposées sur mobile ou en portrait, côte à côte sur desktop paysage. Chaque moitié défile indépendamment lorsque son contenu est plus long.
- La création place QR code et lien direct en haut, puis joueurs, difficulté, nombre de manches, durée et démarrage en bas. Les thèmes restent internes au catalogue; il n'existe ni choix de thème ni bouton « Enregistrer ». « Démarrer la partie » reste indisponible tant qu'un projecteur et un autre téléphone de dessin ne sont pas connectés.
- La saisie d’un code utilise six cases, convertit les lettres en majuscules, écarte les caractères ambigus et rejoint automatiquement la salle au sixième caractère.
- Le lien et le QR code utilisent l’URL directe `/?join=CODE`. L’ouverture de cette URL préremplit le code et tente immédiatement la connexion.
- L’écran du dessinateur est l'exception au 50/50 : une barre toujours visible regroupe le crayon, la gomme, l’épaisseur, annuler, rétablir et l’effacement confirmé au-dessus du canevas. Une action pleine largeur en bas interrompt la manche et ouvre la sélection du gagnant.
- Pendant la phase de dessin, le projecteur masque le mot, le chronomètre, les scores et les indications de manche : seule la toile est rendue. Un toucher peut faire apparaître brièvement les contrôles techniques de projection. Une perte de connexion constitue la seule exception et affiche une reprise explicite plutôt qu’une image figée. Les informations de partie reviennent avant, entre et après les manches.
- Chaque vue projetée est pré-inversée horizontalement afin que le dessin et le texte retrouvent leur sens normal après la réflexion du plexiglas.
- La projection ne propose que le plexiglas en V à deux faces. Sa composition reste identique en portrait et paysage, sans message ni verrouillage d'orientation.

## Prérequis

- Node.js 22 ou supérieur
- Un compte Cloudflare pour les déploiements

## Démarrage local

```bash
npm install
npm run dev
```

Ouvrir ensuite `http://localhost:8787`. Sur le téléphone de projection, créer une salle, inscrire les joueurs, puis faire rejoindre les terminaux avec le QR code, le lien direct ou le code court. Le contrôleur passe automatiquement en mode projection au lancement.

`npm run dev:ui` démarre uniquement Vite. Cette commande convient au travail visuel, mais le jeu temps réel nécessite `npm run dev` pour disposer du Worker et du Durable Object.

## Vérifications

```bash
npm run build
npm test
npm run check
```

`npm run check` génère les types Wrangler, vérifie TypeScript, construit le bundle Vite puis exécute toute la suite Vitest. Les tests couvrent le moteur de jeu, le Worker/Durable Object, les limites HTTP, le protocole de reprise, le modèle de dessin et la normalisation des codes. Leur nombre évolue avec le produit ; la sortie de Vitest reste la source de vérité plutôt qu’un total figé dans ce document.

## Architecture

- [`src/domain`](src/domain) contient les règles et l’état métier sans dépendance à React.
- [`src/shared/protocol.ts`](src/shared/protocol.ts) définit avec Zod les commandes client, snapshots et messages serveur stricts.
- [`src/server/worker.ts`](src/server/worker.ts) porte les routes HTTP, les en-têtes, les limites de corps et les bindings de limitation de débit.
- [`src/server/room.ts`](src/server/room.ts) porte l’autorité de salle : SQLite, alarmes, autorisations, WebSockets, révisions et diffusion.
- [`src/client/session.ts`](src/client/session.ts) centralise la session locale, la saisie du code, les appels API et les URL de connexion.
- [`src/client/useRoomConnection.ts`](src/client/useRoomConnection.ts) gère le ticket, le WebSocket, l’annulation des connexions obsolètes et la reconnexion avec délai exponentiel et gigue.
- [`src/client/room-state.ts`](src/client/room-state.ts) valide les messages serveur et fusionne les deltas selon leur révision, leur tour, leur époque de canevas et leur offset.
- [`src/client/drawing`](src/client/drawing) isole le modèle de rendu et le composant canevas réutilisé par le dessinateur et la projection.
- [`src/client/App.tsx`](src/client/App.tsx) orchestre les écrans et les interactions de jeu.

Le démarrage est une commande atomique `start_game { settings }` : des réglages invalides ne peuvent pas être enregistrés séparément. Le Durable Object vérifie aussi la présence réelle d'un projecteur et d'un autre téléphone en mode dessin. Chaque état persisté possède une `revision`. Les deltas de trait transportent aussi `turnId`, `canvasRevision` et `offset` ; un fragment ancien, manquant ou reçu après annulation, rétablissement ou effacement provoque une resynchronisation au lieu de corrompre la toile. Une seule connexion WebSocket reste active par session.

## Déroulé et projection

Une salle accepte de 1 à 12 joueurs inscrits et jusqu’à 16 sessions de téléphone terminal. À chaque manche, donnez un terminal au dessinateur désigné : il prend la manche, se déclare prêt, dessine puis choisit le joueur qui a trouvé — ou « Aucun gagnant ». Le joueur désigné et le dessinateur gagnent chacun un point, et le joueur désigné devient le dessinateur de la manche suivante. Une seconde validation de la même manche est refusée côté serveur.

Le dessinateur peut interrompre la manche dès qu’un joueur trouve. À la fin du chronomètre, le dessin se fige et la partie attend sa décision : s’il choisit « Aucun gagnant », personne ne marque et le prochain dessinateur est tiré au sort parmi les autres joueurs. Un dessinateur qui ne se déclare pas prêt ou ne commence pas à dessiner est remplacé après 30 secondes. Le mot est ensuite révélé pendant cinq secondes avant l’enchaînement automatique.

Le projecteur utilise uniquement un plexiglas en V à deux faces. La composition est tournée de 90° dans le sens horaire : les deux cellules carrées sont empilées dans un stage 1:2, avec les mêmes transformations en portrait comme en paysage; seule son échelle s'adapte à l'espace disponible. L'application ne verrouille pas l'orientation et n'affiche aucune consigne de rotation. Pour de meilleurs résultats, augmenter la luminosité, activer la projection et centrer le V sur la mire.

À la fin, le contrôleur peut préparer une nouvelle partie. Les joueurs et les réglages sont conservés, tandis que les scores, la manche courante, le classement final et l'historique des mots sont réinitialisés côté serveur.

## Fiabilité, limites et sécurité

- Les corps JSON HTTP sont limités à 4 KiB et les trames WebSocket textuelles à 24 000 octets. Les trames binaires ou surdimensionnées ferment la connexion avec le code 1009.
- Les schémas Zod refusent les propriétés inattendues. Les rôles sont contrôlés de nouveau dans le Durable Object ; masquer une action dans React n’est jamais utilisé comme autorisation.
- Les bindings Cloudflare configurent, par minute et par adresse IP, 5 créations, 40 tentatives de rejoindre et 120 demandes de ticket. Une seconde limite autorise 12 tickets par minute et par session. Chaque session est aussi limitée à 40 trames WebSocket par seconde, y compris les commandes invalides.
- Les jetons de session sont aléatoires et les tickets WebSocket sont à usage unique, valables 60 secondes. Le mot secret n’est présent que dans le snapshot du terminal dessinateur actif.
- Un trait réseau contient au plus 96 points ; le moteur borne également chaque trait, le nombre de traits et le total de points d’un tour.
- Les mutations sont persistées avant diffusion. Une erreur d’envoi ferme seulement le socket concerné et ne bloque pas les autres participants.
- Une salle expire après deux heures sans activité. L’alarme est toujours planifiée à la première échéance entre la transition de phase et cette expiration. Rejoindre un code inconnu renvoie 404 sans initialiser de table métier.
- Le service worker ne traite jamais `/api/` et ne met en cache que les navigations et ressources statiques prévues. Les WebSockets et données de jeu ne sont pas mis en cache.

Le jeton de reprise demeure stocké dans `localStorage`. Ce compromis permet la reprise PWA, mais une XSS exécutée sur la même origine pourrait le lire. La CSP restrictive, l’absence de rendu HTML brut et le caractère éphémère des salles réduisent le risque sans le supprimer ; le détail figure dans le rapport de sécurité.

Le code de salle et son QR constituent une invitation au jeu, pas une identité utilisateur. Toute personne qui les possède peut ouvrir un terminal ; ne les diffusez donc qu’aux participants présents. Une approbation individuelle par le contrôleur serait nécessaire pour un usage dans un groupe non fiable.

## Déploiement

```bash
npm run deploy:staging
npm run deploy:production
```

Staging et production possèdent chacun leur Durable Object SQLite. Le workflow GitHub Actions [`.github/workflows/deploy-production.yml`](.github/workflows/deploy-production.yml) se lance sur chaque push vers `main`. Il utilise `npm ci`, audite les dépendances de production au seuil modéré, exécute `npm run check`, puis déploie le Worker de production.

Avant le premier déclenchement, créer dans GitHub (`Settings` → `Secrets and variables` → `Actions`) ces deux *repository secrets* :

- `CLOUDFLARE_API_TOKEN` : un jeton Cloudflare dédié au CI, limité au compte et créé à partir du modèle **Edit Cloudflare Workers** ; ne pas utiliser le jeton de connexion personnel de Wrangler.
- `CLOUDFLARE_ACCOUNT_ID` : l’identifiant du compte qui héberge le Worker.

Pour n’autoriser que des déploiements issus de merges, la règle de branche de `main` doit exiger une pull request et interdire les pushes directs.

## Validations manuelles encore nécessaires

Les comportements dépendant du matériel ou du navigateur ne sont pas prouvés par les tests unitaires :

- scanner le QR code et confirmer la connexion directe sur iOS et Android ;
- contrôler la saisie tactile, le clavier mobile et l’affichage 50/50 sur plusieurs hauteurs d’écran ;
- vérifier sur le plexiglas en V le sens réel après réflexion et la stabilité de la composition en portrait puis paysage ;
- tester le plein écran, la rotation physique de l'appareil et la reprise du Wake Lock après un passage en arrière-plan ;
- couper puis rétablir le réseau pendant un trait, après un effacement et entre deux manches ;
- refaire les mesures Lighthouse, Core Web Vitals et tailles de bundle sur le build final.

Le protocole de validation et les limites des preuves disponibles sont détaillés dans [`docs/quality-audit.md`](docs/quality-audit.md) et [`security_best_practices_report.md`](security_best_practices_report.md).
