# Prisme — Pictionary holographique

PWA multijoueur pour une projection type Pepper’s ghost : un téléphone affiche le prisme, un autre contrôle la partie et les joueurs dessinent depuis leurs téléphones.

## Prérequis

- Node.js 22 ou supérieur
- Un compte Cloudflare pour les déploiements

## Démarrage local

```bash
npm install
npm run dev
```

Ouvrir ensuite `http://localhost:8787`. Le contrôleur crée une salle, les joueurs et le projecteur rejoignent avec le QR code ou le code court affiché.

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

## Projection

Le projecteur choisit une mire pour pyramide (4 faces), plexiglas en V (2 faces) ou plaque simple (1 face). Pour de meilleurs résultats, mettre l’écran à luminosité maximale, activer le plein écran et centrer le plexiglas sur la mire.
