# Instructions Codex — PictioFady

## Démarrage à faible contexte

- Commencer par `git status --short`, puis cibler les fichiers avec `rg`; ne pas lire tout le dépôt, `App.tsx`, le README ou les rapports par défaut.
- Pour toute modification, analyse ou vérification propre à ce dépôt, utiliser le skill `$pictiofady-maintainer` dans `.agents/skills/pictiofady-maintainer/` et ne charger que la référence indiquée par son routeur.
- Le code et les tests sont la source de vérité. Mettre à jour la référence du skill concernée si un contrat durable change.

## Règles de travail

- Préserver les changements existants. Ne jamais commit, push, déployer, ajouter une dépendance de production ou modifier un secret sans demande explicite.
- Utiliser Node.js 22+, npm et TypeScript strict. Garder `src/shared/protocol.ts` comme contrat unique du transport et le Durable Object comme autorité métier.
- Chercher le plus petit changement cohérent; couvrir les transitions, autorisations et courses côté serveur, pas seulement dans React.
- Ne jamais éditer ni versionner `dist/` ou `src/server/worker-configuration.d.ts`; les commandes de build peuvent les régénérer. Après une modification Wrangler, lancer `npm run types`.

## Vérification

- Pendant l'itération, lancer le scope minimal via `.agents/skills/pictiofady-maintainer/scripts/verify.sh <scope>`.
- Avant livraison d'un changement de code, protocole ou configuration, lancer `npm run check` sauf contrainte explicitement signalée.
- Pour une modification documentaire uniquement, lancer au minimum `git diff --check HEAD` et le validateur du skill si ses fichiers changent.
- Les comportements tactiles, plein écran, QR code et réflexion physique exigent une validation réelle sur appareil; ne pas les déclarer prouvés par Vitest.
