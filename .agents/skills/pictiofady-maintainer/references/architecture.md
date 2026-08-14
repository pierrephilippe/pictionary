# Architecture et contrats temps réel

Charge cette référence pour le métier, le protocole, le serveur, la persistance, la sécurité ou les courses de connexion.

## Flux autoritaire

```text
React -> commande Zod -> Worker HTTP/WS -> GameRoom Durable Object
      <- snapshot/delta validé <- persistance SQLite + diffusion sûre
```

- Le Durable Object est l'autorité pour la salle, les rôles, le mot secret, les délais, le dessin, les scores et les transitions.
- `RoomState` est durable. `RoomSnapshot` est la vue publique filtrée par session. Le reducer client est la seule fusion du réseau dans l'état React.
- Les brouillons de réglages, outils et gestes en cours restent éphémères côté client. La présence des appareils est éphémère côté salle et n'entre jamais dans `RoomState`.

## Carte des modules

| Zone | Source de vérité |
| --- | --- |
| Types et phases métier | `src/domain/types.ts` |
| Transitions et autorisations métier | `src/domain/game.ts` |
| Dictionnaire éditorial et catalogue généré | `src/domain/data/dictionary.fr.json`, `src/domain/catalogue.ts` |
| Commandes et messages Zod | `src/shared/protocol.ts` |
| Routes, en-têtes, corps et rate limits HTTP | `src/server/worker.ts` |
| SQLite, sessions, tickets, WebSockets, alarmes | `src/server/room.ts` |
| Session locale et URL directe | `src/client/session.ts` |
| Cycle ticket/WebSocket/reconnexion | `src/client/useRoomConnection.ts` |
| Validation et réduction snapshot/delta | `src/client/room-state.ts` |
| Entrée et rendu du canevas | `src/client/drawing/` |
| Orchestration des écrans | `src/client/App.tsx` |

## Invariants métier

- Phases : `lobby -> awaiting_ready -> armed -> drawing -> resolving -> revealing -> finished`. `resolving` fige la toile après le chrono et attend une décision explicite du dessinateur; les alarmes font progresser ou expirer la salle côté serveur.
- Le contrôleur inscrit les joueurs et lance atomiquement `start_game { settings }` avec une seule `difficulty`. Le Durable Object exige alors un projecteur WebSocket actif et un autre terminal actif en mode dessin; une session HTTP simplement créée ne compte pas. Les anciens réglages `difficulties[]` sont normalisés vers un niveau unique lors de la restauration persistée.
- Un terminal prend le tour attendu, reçoit seul le mot lorsqu'il est dessinateur, se déclare prêt, puis peut dessiner ou résoudre immédiatement la manche.
- Le serveur recalcule toutes les capacités (`canDraw`, `canTakeDrawingTurn`, `canSelectWinner`) et refuse toute commande hors rôle, session, tour ou phase.
- Une seule résolution est admise. Le joueur désigné par le dessinateur devient toujours le dessinateur suivant; « Aucun gagnant » choisit aléatoirement un autre joueur. Les scores et le prochain dessinateur sont calculés par le serveur, jamais par le client.
- Le catalogue de mots est interne : `prompts` regroupe directement chaque univers par difficulté dans le JSON éditorial. Chaque entrée est un mot ou concept autonome; le catalogue les aplatit sans fabriquer de variantes ni concaténer de qualificatifs. Les IDs dérivent de l'univers, du niveau et du libellé plutôt que de la position; les tests protègent au moins 75 entrées par univers/niveau et l'unicité globale des libellés dans chaque niveau.
- À la restauration d'une salle antérieure aux IDs stables, les anciens `word-N` sont abandonnés afin de ne pas exclure un autre mot par erreur; le mot du tour courant est remappé vers son ID stable. Cette compatibilité peut seulement permettre la répétition d'un mot joué avant le déploiement pendant la courte vie résiduelle de la salle.
- Après `finished`, seul le contrôleur peut envoyer `return_to_lobby`. La transition conserve joueurs, réglages et séquence de tours, mais remet scores, manche, gagnants et mots utilisés à zéro avant une nouvelle préparation.
- Seul le contrôleur peut envoyer `delete_room`. Cette destruction efface l'état durable et l'alarme, ferme chaque WebSocket avec la raison `Room deleted`, puis interdit toute nouvelle invitation, tout ticket et toute reprise de la salle.

## Invariants de synchronisation

- Chaque snapshot possède une `revision` monotone.
- Chaque delta de trait porte `turnId`, `canvasRevision` et `offset`. Refuser ou resynchroniser les anciens tours, anciennes époques, duplications et trous d'offset.
- `undo`, `redo` et `clear` changent l'époque du canevas; un fragment tardif de l'ancienne époque ne doit jamais réapparaître.
- Les commandes discrètes doivent être atomiques ou corrélables. Ne jamais envoyer séparément configuration puis démarrage.
- Une tentative WebSocket obsolète ne doit pas modifier l'état courant. Une seule connexion active est conservée par session; une fermeture de remplacement ne boucle pas automatiquement.
- Une diffusion défaillante isole et ferme le socket fautif sans annuler une mutation déjà persistée ni priver les autres clients.
- `RoomSnapshot.devicePresence` est recalculé depuis les WebSockets ouverts, dédupliqués par session, puis rediffusé aux connexions, changements de mode et déconnexions. Une mise à jour de présence peut conserver la même `revision` métier.

## Frontières de sécurité et de durée de vie

- Les schémas Zod sont stricts et bornés; conserver les limites imbriquées et les plafonds de points/traits.
- Les tickets WebSocket sont courts et à usage unique. Les jetons de reprise sont sensibles même s'ils vivent dans `localStorage`.
- Le code/QR est une invitation, pas une identité. Une personne qui le connaît peut ouvrir un terminal; un groupe non fiable exigerait approbation/révocation par le contrôleur.
- L'activité réseau de ticket ou de handshake ne doit pas, à elle seule, prolonger l'inactivité métier d'une salle.
- Rate limits, CSP, cache du service worker et origine WebSocket sont des couches complémentaires, jamais des autorisations métier.
- Tous les assets passent par le Worker (`run_worker_first: true`). En production, toute URL HTTP est redirigée en 308 vers la même URL HTTPS et toutes les réponses portent HSTS; ne pas réintroduire une route statique qui contourne cette frontière.
- Lors d'un changement Wrangler, garder les bindings cohérents dans chaque environnement et régénérer les types.

## Impact minimal par changement

- Nouvelle commande : protocole -> domaine -> room -> client -> tests.
- Nouvelle phase ou transition : types -> invariants domaine -> alarmes -> snapshots -> vues -> tests de reprise.
- Changement de trait : protocole + epoch/offset -> domaine -> reducer -> canevas -> tests ordre/duplication/reconnexion.
- Changement de session/API : `session.ts` + Worker/room + reconnexion + tests d'autorisation et d'abus.
