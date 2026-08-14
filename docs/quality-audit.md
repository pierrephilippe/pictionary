# Revue qualité complète — PictioFady

Audit réalisé le 14 août 2026 sur le code du dépôt, le Worker local complet et Chromium. Les constats sont classés en défauts confirmés, risques probables et améliorations facultatives. Aucun score Lighthouse, Core Web Vital, test tactile réel, scan QR physique ou résultat optique sur plexiglas n'est extrapolé.

## Synthèse

- Aucun P0 n'a été trouvé.
- Un P1 de continuité reste ouvert : si le téléphone dessinateur et son jeton sont perdus définitivement, la salle peut rester bloquée en résolution jusqu'à son expiration. Sa correction demande de choisir qui peut reprendre l'autorité du dessinateur.
- Le site déployé acceptait encore HTTP sans redirection ni HSTS lors de la vérification. Le dépôt force désormais le passage de tous les assets par le Worker, redirige HTTP vers HTTPS en production et ajoute HSTS ; la production ne sera corrigée qu'après déploiement et contrôle externe.
- Les P1 UX constatés sur l'invitation, le paysage court, le dessin continu et le faux enrichissement du dictionnaire ont été corrigés et couverts par tests ou contre-tests navigateur.
- Les principaux risques P2 concernent l'inertie des modales, la compatibilité de protocole lors d'un déploiement PWA, la validation des états persistés et le coût du document SQLite monolithique.

## Défaut confirmé encore ouvert

### P1 — Continuité temps réel — perte définitive du téléphone dessinateur

- **Preuve :** `src/domain/game.ts:182-187` lie les commandes à `drawerTerminalSessionId`; `src/domain/game.ts:340-369` exige encore cette session après expiration du chrono; `src/server/room.ts:239-247` ne réattribue rien à la fermeture; `src/server/room.ts:601-610` n'arme aucune échéance propre à `resolving`.
- **Reproduction :** lancer une manche, prendre le tour sur un terminal, commencer à dessiner, perdre définitivement ce téléphone ou son jeton, puis laisser expirer le chrono.
- **Impact :** aucun autre téléphone ni le contrôleur ne peut désigner le gagnant ou choisir « Aucun gagnant » ; la partie attend jusqu'au TTL de la salle.
- **Cause racine :** la fonction d'arbitrage est une capacité de session sans protocole de relève.
- **Correction recommandée :** après une grâce courte, permettre au contrôleur d'autoriser un autre terminal à reprendre le même joueur dessinateur, sans lui révéler le mot avant cette approbation. Une dérogation directe du contrôleur serait une autre règle produit.
- **Test de non-régression :** fermer et perdre la session dessinateur en `drawing` puis `resolving`, déclencher la grâce, reprendre depuis une nouvelle session autorisée et vérifier qu'une seule résolution est acceptée.
- **Pourquoi non corrigé automatiquement :** le propriétaire légitime de la décision doit être choisi explicitement sans contredire la règle « le dessinateur désigne le gagnant ».

## P1 corrigés pendant la revue

### Transport HTTPS

- **Catégorie :** sécurité / déploiement.
- **Preuve initiale :** `http://pictionary.fady.eu/` et `/api/health` répondaient `200` en clair le 14 août 2026 ; HTTPS n'envoyait pas HSTS.
- **Reproduction :** `curl -I http://pictionary.fady.eu/` puis `curl -I https://pictionary.fady.eu/`.
- **Impact :** un attaquant sur le réseau pouvait injecter le bundle, voler le Bearer stocké localement et propager une URL ou un WebSocket non chiffré via le QR.
- **Cause racine :** les assets pouvaient court-circuiter le Worker et aucune redirection edge n'était imposée.
- **Correction :** `wrangler.jsonc:6-10` place désormais le Worker avant tous les assets ; `src/server/worker.ts:14-33,128-134` ajoute HSTS et une redirection 308 conservant chemin et requête ; `public/_headers:1-8` protège aussi les assets.
- **Test ajouté :** `tests/room.test.ts` vérifie redirection, conservation de l'URL, absence de redirection locale et HSTS sur l'API.
- **Validation restante :** déployer explicitement puis retester HTTP et HTTPS sur l'URL publique. `includeSubDomains` et `preload` restent exclus tant que tous les sous-domaines ne sont pas audités.

### Invitation directe et petit écran

- **Catégorie :** UX / accessibilité / responsive.
- **Preuve initiale :** à 320×568, le lien n'existait que comme arrêt clavier invisible de 1×1 px ; le QR puis le bouton de copie dépassaient de la moitié haute masquée.
- **Reproduction :** créer une salle à 320×568 et comparer les rectangles du QR et du bouton à `.invite-scroll`.
- **Impact :** lien introuvable, tabulation déroutante et QR potentiellement illisible.
- **Cause racine :** contenu trop dense dans une demi-hauteur fixe et absence d'action visible.
- **Correction :** `src/client/App.tsx:719-728,759-768` expose « Copier le lien » ; `src/client/styles.css:103-113,445-450` compacte la carte et garantit une cible de 44 px.
- **Contre-test :** moitié haute 320×284 sans scroll, QR 80×80 et bouton 85,7×44 entièrement contenus ; la copie produit exactement `origin/?join=CODE`.

### Actions terminal en paysage court

- **Catégorie :** jouabilité / responsive.
- **Preuve initiale :** à 667×375, « Quitter la salle » occupait `y=358,6–402,6` et sortait du viewport.
- **Reproduction :** rejoindre comme terminal hors dessin, basculer en paysage 667×375.
- **Impact :** une action essentielle était inaccessible alors que le design interdit le scroll.
- **Cause racine :** empilement vertical dans une demi-zone de 187,5 px.
- **Correction :** `src/client/styles.css:452-469` place titre, actions et sortie sur une rangée compacte.
- **Contre-test :** contenu bas `scrollHeight=188`, bouton `y=259–303`, entièrement visible.

### Geste continu supérieur à 1 024 points

- **Catégorie :** jouabilité / performance / protocole.
- **Preuve initiale :** l'ancien `DrawingBoard` accumulait un seul trait sans borne, alors que `src/domain/game.ts:246-263` refuse un trait au-delà de 1 024 points ; un envoi WebSocket réussi était retiré localement avant tout acquittement métier.
- **Reproduction :** maintenir le doigt ou le stylet sur plus de 1 024 échantillons distincts.
- **Impact :** la fin du trait disparaissait au relâchement et le brouillon grandissant était cloné puis repeint à chaque frame.
- **Cause racine :** la limite autoritaire n'était pas reflétée dans le modèle d'entrée client.
- **Correction :** `src/domain/types.ts:5-8` centralise les limites ; `src/client/drawing/model.ts:12-24` crée une continuation avec point de jonction ; `src/client/App.tsx` segmente et conserve les brouillons jusqu'à leur confirmation ; `DrawingCanvas` accepte plusieurs segments locaux. Tout message d'erreur autoritaire incrémente aussi une séquence dans `useRoomConnection`, annule les brouillons non confirmés et affiche le refus au dessinateur afin de rester identique au projecteur.
- **Tests :** `tests/drawing.test.ts` injecte 1 100 échantillons, obtient deux traits bornés et vérifie la continuité exacte du point de jonction. En Chromium, 1 102 points ont produit deux traits complets de 1 023 et 79 points, toujours visibles après confirmation.
- **Risque résiduel :** le transport ne possède toujours pas d'acquittement explicite par `commandId`; une rupture après `WebSocket.send()` mais avant traitement serveur peut nécessiter de refaire le trait.

### Dictionnaire artificiellement gonflé

- **Catégorie :** contenu / jouabilité / maintenabilité.
- **Preuve initiale :** `catalogue.ts` fabriquait 9 000 formulations en concaténant des qualificatifs aux mêmes mots, au lieu de proposer de vrais concepts difficiles.
- **Reproduction :** inspecter les anciennes entrées difficiles générées et compter les sources JSON réelles.
- **Impact :** répétition, formulations peu naturelles et coût de démarrage pour une richesse fictive.
- **Cause racine :** un objectif quantitatif de catalogue avait remplacé l'éditorial réel.
- **Correction :** `src/domain/data/dictionary.fr.json` contient maintenant 75 entrées directes par thème et difficulté ; `src/domain/catalogue.ts` aplatit seulement `prompts`, refuse les valeurs vides et les doublons globaux d'un même niveau, ne concatène rien et dérive des IDs stables du thème, du niveau et du libellé. La restauration oublie les anciens IDs positionnels plutôt que d'exclure le mauvais mot.
- **Test ajouté :** `tests/game.test.ts` vérifie au moins 1 125 concepts directs, l'ordre exact du JSON, au moins 75 entrées par niveau, l'unicité globale et la stabilité des IDs ; `tests/room.test.ts` couvre la migration d'un ancien `word-N`.

### Suppression du contrôleur hors ligne

- **Catégorie :** cycle de vie / récupération.
- **Preuve initiale :** la sortie locale pouvait effacer le jeton contrôleur sans envoyer `delete_room`, laissant la salle et les terminaux orphelins.
- **Reproduction :** démarrer, couper la connexion du contrôleur, ouvrir les réglages de projection et quitter.
- **Impact :** salle inutilisable jusqu'au TTL et contrôleur incapable de la supprimer ensuite.
- **Cause racine :** même action visuelle pour la sortie locale et la destruction autoritaire.
- **Correction :** `src/client/App.tsx:1198-1213` conserve la session contrôleur tant que la salle n'est pas déclarée indisponible et fournit toujours la commande de suppression ; le serveur ferme déjà tous les sockets et le client revient à l'accueil sur `roomDeleted`.
- **Test de non-régression recommandé :** E2E hors ligne : aucune suppression locale du jeton, CTA de reconnexion, puis suppression accusée et redirection de tous les appareils.

## Défauts confirmés P2 encore ouverts

### Modales : arrière-plan non inerte

- **Catégorie :** accessibilité.
- **Preuve :** `src/client/App.tsx:540,661-689,1036-1067` utilise `aria-modal` et un piège Tab manuel, mais les boutons de fond restent activés et présents dans l'arbre d'accessibilité.
- **Reproduction :** ouvrir Joueurs, Réglages, gagnant ou projection puis inspecter l'arbre AX ou focaliser un contrôle du fond par script.
- **Impact :** navigation virtuelle d'un lecteur d'écran ambiguë et interaction programmatique possible derrière le dialogue.
- **Cause racine :** absence de `<dialog>.showModal()` ou d'attribut `inert` sur les frères.
- **Correction recommandée :** portail de dialogue unique qui rend le reste de l'application `inert`, avec restauration d'état et de focus.
- **Test :** snapshot AX limité au dialogue, fond réellement `inert`, boucle Tab, Escape et retour du focus.

### Déploiement PWA sans négociation de protocole

- **Catégorie :** architecture / compatibilité.
- **Preuve :** `src/shared/protocol.ts:34-49,80-114` ne porte aucun `protocolVersion` ni message `upgrade_required`; l'avis PWA reste une action manuelle.
- **Reproduction :** garder une ancienne page ouverte, déployer un schéma incompatible puis reconnecter en pleine partie.
- **Impact :** rejet de tous les snapshots et boucle de resynchronisation jusqu'à actualisation.
- **Cause racine :** schéma strict sans stratégie N/N−1 ni négociation.
- **Correction recommandée :** version d'enveloppe, réponse explicite d'incompatibilité et rollout additif en deux temps.
- **Test :** fixtures ancien client/nouveau serveur et nouveau client/ancien serveur, y compris reconnexion en partie.

### État durable insuffisamment validé

- **Catégorie :** architecture / fiabilité des données.
- **Preuve :** `src/server/room.ts:517-570` caste le JSON comme v1/v2/v3 puis force `version=3` sans schéma d'exécution complet ni rejet d'une version future.
- **Reproduction :** injecter un payload incomplet ou v4, réveiller le Durable Object puis exécuter une commande persistante.
- **Impact :** crash au réveil ou réécriture destructive lors d'un rollback.
- **Cause racine :** migrations correctives mutables sans validation préalable.
- **Correction recommandée :** schémas persistés par version, migrations pures séquentielles et refus contrôlé de toute version supérieure.
- **Test :** v1/v2 migrés, v3 restauré, payload corrompu et v4 refusés sans écriture.

### Amplification par commandes WebSocket et état monolithique

- **Catégorie :** sécurité / performance / coût.
- **Preuve :** `src/server/room.ts:211-230` persiste même les commandes rejetées ; `src/domain/game.ts:65-74` ne détecte pas un mode d'affichage identique ; `src/server/room.ts:367-421,573-582` réécrit tout l'état et sérialise un snapshot par socket.
- **Reproduction :** avec un code valide, envoyer 39 commandes invalides ou `set_display_mode` identiques par seconde, sous le plafond générique de 40.
- **Impact :** écritures SQLite, sérialisation d'un canevas jusqu'à 8 000 points et diffusion vers jusqu'à 20 sockets.
- **Cause racine :** compteur anti-abus stocké dans le gros document métier, budget unique pour traits et contrôles, absence de no-op.
- **Correction recommandée :** budgets séparés, strikes puis fermeture, compteur dans l'attachement ou une petite ligne dédiée, no-op strict et persistance de traits append-only.
- **Test :** espionner écritures et envois ; 40 no-op/refus ne doivent produire ni 40 révisions ni 40 broadcasts.

### Code de salle comme capacité terminale

- **Catégorie :** sécurité / intégrité de partie.
- **Preuve :** `src/server/room.ts:117-145` permet 16 sessions ; `src/domain/game.ts:172-179` attribue le téléphone au premier appel valide ; le quota de jonction IP permet 40 essais/minute.
- **Reproduction :** connaître le code, ouvrir 16 sessions puis gagner la course `take_drawing_turn`.
- **Impact :** saturation des places et accès possible au mot secret.
- **Cause racine :** le code sert simultanément de découverte et d'autorisation dans un modèle de groupe de confiance.
- **Correction recommandée :** invitations terminales à usage unique ou approbation/révocation par le contrôleur.
- **Test :** une session non approuvée ne consomme pas de place et ne peut pas réclamer le tour.

### Jeton Bearer dans `localStorage`

- **Catégorie :** sécurité / session.
- **Preuve :** `src/client/session.ts:35-54` stocke code, rôle et jeton dans un espace lisible par JavaScript.
- **Reproduction :** lire `pictiofady.active-session` puis rejouer `/ticket`.
- **Impact :** usurpation après XSS, extension malveillante ou accès au profil navigateur.
- **Cause racine :** priorité donnée à la reprise PWA après rechargement.
- **Correction recommandée :** cookie `HttpOnly; Secure; SameSite` avec stratégie CSRF, ou jeton mémoire court et rotation.
- **Test :** aucun Bearer lisible par JavaScript ; ancien jeton rejeté après rotation, sortie et suppression.

## Risques probables P3 et améliorations facultatives

- **PWA/cache :** `public/sw.js:1-59` ne précache pas les assets Vite hashés, conserve les URL de navigation avec leurs requêtes et lance une revalidation de cache sans `event.waitUntil`. Tester première visite puis offline ; canoniser les navigations sur `/`, borner le cache et relier la revalidation à l'événement.
- **Profil de déploiement :** le profil racine et production partagent encore le nom du Worker dans `wrangler.jsonc`; renommer explicitement le service de développement pour éviter une commande manuelle sur la mauvaise cible.
- **CI :** `.github/workflows/deploy-production.yml:3-6` ne vérifie que les pushes sur `main`, juste avant production. Ajouter un workflow PR séparé et épingler les actions par SHA.
- **Capacité ambiguë :** `src/domain/game.ts:430` expose `canDraw=true` dès `awaiting_ready` alors que les traits ne sont acceptés qu'en `armed|drawing`. Introduire `isDrawerTerminal`/`canReady` et réserver `canDraw` aux commandes réellement valides.
- **PWA installable :** `src/client/App.tsx:34-128` intercepte `beforeinstallprompt` mais aucune interface ne consomme `canInstall` ou `install`; retirer ce code mort ou rendre l'installation réellement accessible.
- **Ergonomie facultative :** le canevas carré reste seulement proche de 202×202 px à 320×568. Une barre d'outils encore plus compacte augmenterait le confort, sans masquer les actions basses.
- **Matériel :** scan du QR 80 px, toucher/stylet, Fullscreen/Wake Lock, luminosité, reflet et géométrie réelle du V restent à valider sur appareils. Ce ne sont pas des défauts confirmés par Chromium.

## Parcours et viewports réellement vérifiés

| Contrôle | Résultat Chromium |
| --- | --- |
| 320×568 | Accueil et préparation 50/50, sans scroll ; QR et lien entièrement visibles ; dessin carré ; outils et deux actions basses visibles avant le premier trait. |
| 390×844 | Dessin carré, barre permanente, sélection du gagnant et modales compactes sans scroll global. |
| 667×375 | Deux moitiés de 187,5 px ; actions terminales entièrement accessibles ; projection à deux faces sans message d'orientation. |
| 1280×800 | Accueil et écrans divisés horizontalement en deux zones 640×800. |
| Clavier | Six caractères `abc234` saisis sans délai deviennent `ABC234`, déclenchent automatiquement la jonction et placent désormais le focus sur « Réessayer » après erreur. Radios de difficulté exclusives et navigables aux flèches. |
| Modales | Escape, boucle Tab, taille stable après ajout de joueurs et restauration du focus passent ; l'inertie AX du fond reste ouverte. |
| Projection | Deux faces carrées empilées, transforms miroir/rotation identiques en portrait et paysage ; pendant `drawing`, seule la toile est visible hors contrôles temporaires. |
| Partie | Premier trait démarre le chrono ; interruption/timeout ouvre la résolution ; gagnant → prochain dessinateur ; aucun gagnant → tirage serveur ; fin → retour lobby avec scores remis à zéro. |
| Suppression | Commande serveur efface l'état, ferme les terminaux et redirige le contrôleur à l'accueil. |
| Mouvement réduit | Les animations et pseudo-éléments sont désactivés avec `prefers-reduced-motion: reduce`. |

La réflexion physique, le scan réel, la gestuelle tactile, l'orientation matérielle et le mode plein écran ne sont pas prouvés par ces contrôles.

## Architecture et contrôles positifs

- Le Durable Object reste l'autorité : rôles, session dessinateur, présence d'appareils, score, prochain dessinateur, secret et transitions sont recalculés côté serveur.
- `start_game` transporte ses réglages dans une mutation atomique ; `return_to_lobby` conserve joueurs/réglages et la séquence de tours tout en remettant le jeu à zéro ; `delete_room` efface stockage, alarme et sockets.
- Le protocole Zod strict porte `revision`, `turnId`, `canvasRevision` et `offset`; le reducer ignore les duplicatas cohérents et demande une resynchronisation sur un trou de canevas.
- Les tickets sont aléatoires, à usage unique et courts ; une session remplace son ancien socket ; les commandes sont sérialisées et la persistance précède la diffusion.
- La TTL dépend de l'activité métier et est vérifiée avant les transitions d'alarme ; ticket et simple handshake ne prolongent plus la salle.
- Le mot secret n'est envoyé qu'au terminal dessinateur autorisé.

## Performance mesurée et limites de preuve

Build final de la revue : JS principal 311,08 kB (91,39 kB gzip), chunk QR différé 16,71 kB (6,29 kB gzip), CSS 44,62 kB (9,88 kB gzip). Le dictionnaire direct réduit fortement l'ancien catalogue généré de 9 750 objets à 1 125 concepts.

Le chemin pointeur ne relit plus les dimensions pour chaque événement coalescé et les gestes sont bornés par segment. En revanche, la sérialisation SQLite et le fan-out au plafond de 8 000 points × 20 sockets n'ont pas été profilés. Aucun LCP, INP, CLS, score Lighthouse, consommation batterie ou mémoire n'est affirmé : l'outil DevTools de mesure n'était pas disponible dans cette session.

## Plan d'action ordonné

1. Décider puis implémenter la relève autorisée du téléphone dessinateur perdu (P1).
2. Déployer le correctif HTTPS, activer également « Always Use HTTPS » au niveau de la zone si possible, puis contrôler 308 et HSTS en production.
3. Rendre toutes les modales réellement modales avec `inert` ou `<dialog>` et ajouter des tests AX.
4. Versionner le protocole et les états persistés avant une prochaine rupture de schéma.
5. Séparer budgets WS et stockage des traits, éliminer no-op et persistance d'erreurs, puis benchmarker 8 000 points × 20 sockets.
6. Choisir si le code de salle reste une capacité de groupe fiable ou si le contrôleur doit approuver/révoquer les terminaux.
7. Durcir PWA/cache/CI puis exécuter les validations sur téléphones et support physique.

## Vérifications de référence

```bash
.agents/skills/pictiofady-maintainer/scripts/verify.sh client
.agents/skills/pictiofady-maintainer/scripts/verify.sh domain
.agents/skills/pictiofady-maintainer/scripts/verify.sh server
npm run check
npm audit --omit=dev --audit-level=moderate
git diff --check HEAD
```

Les sorties du dernier passage et les validations restant manuelles doivent être consignées dans la livraison de la modification, plutôt que figées ici pour les commits futurs.
