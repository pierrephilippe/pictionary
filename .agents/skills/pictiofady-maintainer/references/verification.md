# Vérification et livraison

Charge cette référence pour choisir des tests, modifier la configuration, vérifier un build, préparer une recette ou rendre des preuves fiables.

## Commandes stables

```bash
npm run build      # types Wrangler + TypeScript + bundle Vite
npm test           # suite Vitest/Miniflare
npm run check      # build puis suite complète
npm run dev        # build puis Worker/Durable Object local
npm run dev:ui     # UI Vite seule, sans temps réel complet
```

Le script du skill sélectionne un sous-ensemble sans mémoriser les longues commandes :

```bash
.agents/skills/pictiofady-maintainer/scripts/verify.sh client
.agents/skills/pictiofady-maintainer/scripts/verify.sh domain
.agents/skills/pictiofady-maintainer/scripts/verify.sh server
.agents/skills/pictiofady-maintainer/scripts/verify.sh protocol
.agents/skills/pictiofady-maintainer/scripts/verify.sh docs
.agents/skills/pictiofady-maintainer/scripts/verify.sh all
```

## Choisir le scope minimal

| Changement | Tests principaux |
| --- | --- |
| Code de salle, session locale, URL directe | `tests/session.test.ts` |
| Fusion snapshot/delta, reprises, offsets | `tests/room-state.test.ts` |
| Modèle de rendu du dessin | `tests/drawing.test.ts` |
| Contrat de projection en V à deux faces | `tests/projection.test.ts` |
| Phases, scores, autorisations métier | `tests/game.test.ts` |
| Durable Object, tickets, WebSockets, alarmes, migrations | `tests/room.test.ts` |
| Limites HTTP par IP/session | `tests/rate-limit.test.ts` |
| Contrat partagé ou changement transversal | TypeScript + tous les tests concernés, puis `npm run check` |

Les tests actuels n'exercent pas un DOM React complet. Une modification d'interaction ou de CSS exige donc aussi une recette navigateur ciblée.

## Fichiers générés et configuration

- `src/server/worker-configuration.d.ts` est généré par `npm run types`; ne pas l'éditer à la main.
- `dist/` est un artefact local ignoré, régénéré par le build; ne pas l'éditer ni le versionner.
- Garder `wrangler.jsonc` et `wrangler.test.jsonc` alignés sur la date de compatibilité, le Durable Object et les bindings nécessaires aux tests.
- Les bindings non héritables doivent être répétés dans chaque environnement concerné.
- N'ajouter une dépendance qu'avec autorisation explicite et vérifier ensuite l'audit npm approprié.

## Niveau de preuve attendu

- Code, protocole, serveur ou configuration : scope ciblé pendant l'itération, puis `npm run check` avant livraison.
- Documentation/skill uniquement : `git diff --check HEAD`, validation du skill et contrôle des liens/commandes cités.
- UI : build + recette des viewports touchés, navigation clavier et état de connexion. Pour la projection, comparer ratio, cellules et transformations en portrait puis paysage.
- Temps réel : inclure ordre ancien/nouveau, duplications, reconnexion, deuxième session/onglet et alarmes lorsque pertinent.
- Sécurité : démontrer le refus côté serveur et un test d'abus; ne pas conclure à partir d'un bouton masqué.

## Handoff

Donner seulement : résultat, fichiers importants, vérifications effectivement exécutées et limites manuelles restantes. Ne pas annoncer un déploiement, une validation physique ou un audit complet qui n'a pas eu lieu.
