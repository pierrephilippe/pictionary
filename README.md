# PictioFady — Pictionary holographique

PWA multijoueur pour une projection type Pepper’s ghost : le téléphone qui crée la salle devient l’écran du prisme au lancement. Les joueurs sont inscrits sur ce téléphone principal ; les autres téléphones servent uniquement de terminaux de dessin interchangeables.

L’application peut être installée depuis le navigateur. Elle conserve son interface hors ligne pour un redémarrage propre, mais une connexion est toujours nécessaire pendant une partie : le dessin, les scores et le mot secret restent autoritaires dans le Durable Object.

## Prérequis

- Node.js 22 ou supérieur
- Un compte Cloudflare pour les déploiements

## Démarrage local

```bash
npm install
npm run dev
```

Ouvrir ensuite `http://localhost:8787`. Sur le téléphone de projection, créer une salle, inscrire les joueurs, puis faire rejoindre les téléphones terminaux avec le QR code ou le code court affiché. Au lancement, cet écran passe automatiquement en mode projection.

`npm run dev:ui` démarre uniquement Vite : il sert au travail visuel, mais le jeu temps réel nécessite `npm run dev`.

## Vérifications

```bash
npm run build
npm test
npm run check
```

Le moteur de jeu est isolé dans `src/domain`, le Worker et le Durable Object dans `src/server`, et React dans `src/client`.

## Déploiement

```bash
npm run deploy:staging
npm run deploy:production
```

Les environnements staging et production possèdent chacun leur Durable Object SQLite. Les salles, scores et dessins sont temporaires : une salle inactive est supprimée après deux heures.

### Déploiement continu de production

Le workflow GitHub Actions [`.github/workflows/deploy-production.yml`](.github/workflows/deploy-production.yml) se lance à chaque push sur `main`, donc aussi après chaque merge vers cette branche. Il installe les dépendances de façon reproductible, exécute `npm run check`, puis déploie le Worker de production.

Avant le premier déclenchement, créer dans GitHub (`Settings` → `Secrets and variables` → `Actions`) ces deux *repository secrets* :

- `CLOUDFLARE_API_TOKEN` : un jeton Cloudflare dédié au CI, limité au compte et créé à partir du modèle **Edit Cloudflare Workers** ; ne pas utiliser le jeton de connexion personnel de Wrangler.
- `CLOUDFLARE_ACCOUNT_ID` : `db89e54a855ccb7a30730e80a971c766`.

La règle de branche GitHub doit exiger une pull request pour `main` si l’on veut que les déploiements proviennent exclusivement de merges, et non de pushes directs.

## Déroulé et projection

Une partie peut inclure un seul joueur et jusqu’à 16 téléphones terminaux. À chaque tour, donnez n’importe quel téléphone terminal au dessinateur désigné : il démarre son tour, dessine puis sélectionne dans la liste le joueur qui a trouvé — ou « Personne n’a trouvé ». Le gagnant et le dessinateur gagnent chacun un point. Sans validation avant la fin du chronomètre, personne ne marque. Un dessinateur qui ne se déclare pas prêt ou ne commence pas à dessiner est remplacé après 30 secondes ; le mot reste révélé cinq secondes, puis le tour suivant commence automatiquement.

Le téléphone créateur choisit une mire pour pyramide (4 faces), plexiglas en V (2 faces) ou plaque simple (1 face). Pour de meilleurs résultats, mettre l’écran à luminosité maximale, activer le plein écran et centrer le plexiglas sur la mire. En V ou sur plaque, tournez l’écran en paysage ; en pyramide, le portrait est privilégié.

## Fiabilité et sécurité

- Le Worker applique des en-têtes de sécurité sur l’interface et les API, refuse les corps JSON dépassant 4 KiB et valide strictement chaque commande.
- Les jetons de session et tickets WebSocket sont opaques, courts et validés côté Durable Object ; le mot n’est inclus que dans le snapshot du terminal dessinateur actif.
- Les traits sont limités côté protocole et moteur, persistés avant diffusion, puis restaurés au reconnect. Le client espace ses reconnexions et reprend dès le retour du réseau.
- Le service worker ne met en cache que l’enveloppe statique de l’application. Les routes `/api/` et les WebSockets ne sont jamais mis en cache.

## Compatibilité mobile à valider sur appareils physiques

Le mode projection est conçu pour être fiable sans dépendre d’API optionnelles : il utilise la totalité du viewport visible, puis demande le plein écran, l’orientation et le maintien d’écran actif lorsqu’ils sont disponibles.

- **Safari iOS récent :** l’installation passe par le menu Partager ; le plein écran et le verrouillage d’orientation peuvent être indisponibles. Le mode immersif CSS et l’indication « tournez le téléphone » restent donc la solution de repli.
- **Chrome Android récent :** vérifier l’entrée/sortie du plein écran après action utilisateur, le verrouillage paysage en V/plaque et la reprise du `Wake Lock` après retour au premier plan.
- **Dans les deux cas :** vérifier le dessin tactile, le QR/code court, la reconnexion après mode avion, la restauration du dessin et le rendu réel des trois supports à luminosité maximale.

Les résultats synthétiques et le détail des audits sont consignés dans [`docs/quality-audit.md`](docs/quality-audit.md) et [`security_best_practices_report.md`](security_best_practices_report.md).
