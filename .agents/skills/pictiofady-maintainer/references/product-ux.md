# Contrat produit et UX

Charge cette référence pour une modification d'écran, de contenu, de dessin, de projection, d'accessibilité ou une validation visuelle.

## Parcours à préserver

- Accueil mobile et écrans en portrait : deux zones superposées de même hauteur, « Créer une partie » et « Rejoindre une partie ». Sur un écran desktop large en paysage, les placer côte à côte à 50 % de la largeur chacune.
- Les écrans applicatifs hors dessin suivent le même responsive : deux moitiés superposées de même hauteur sur mobile ou en portrait, puis deux colonnes de même largeur sur desktop paysage. Chaque moitié défile sans déplacer l'autre. La projection en V matérialise ses deux faces égales.
- Création : demander uniquement difficultés, nombre de manches et durée par manche. Ne proposer ni thème ni bouton ambigu « Enregistrer »; le CTA lance avec les réglages affichés.
- Préparation : placer QR code et lien direct dans la moitié haute, puis joueurs, réglages et démarrage dans la moitié basse. Le démarrage exige un projecteur connecté et un autre téléphone connecté en mode dessin; annoncer chaque présence sans dépendre de la couleur.
- Rejoindre : six cases tactiles, lettres normalisées en majuscules, caractères ambigus écartés, validation automatique au sixième caractère et action claire pour réessayer.
- Invitation : QR code et lien pointent directement vers `/?join=CODE`; l'URL préremplit et tente la connexion sans écran intermédiaire.
- Employer « manche » partout, jamais un mélange « manche/tour » dans le texte utilisateur.

## Dessinateur

- Garder l'écran dominé par la zone de dessin, avec le mot secret complet et un chrono stable.
- Afficher en permanence crayon, gomme, épaisseur, annuler, rétablir et effacement confirmé dans une barre compacte au-dessus du canevas. Indiquer les états sélectionnés visuellement et avec `aria-pressed`.
- Garder la résolution de manche hors de la barre d'outils : action basse « Interrompre la manche et désigner le gagnant », puis feuille compacte de sélection. Au timeout, figer la toile et ouvrir une résolution obligatoire.
- Le joueur désigné devient le prochain dessinateur. « Aucun gagnant » ne marque aucun point et déclenche un tirage au sort serveur parmi les autres joueurs.
- Ne placer aucune action « quitter » au-dessus du canevas. La sortie est secondaire, dans un menu ou en fin de contenu, avec confirmation lorsque le risque le justifie.
- En reconnexion, empêcher les gestes trompeurs et expliquer si le dessin est conservé, à reprendre ou impossible à envoyer.

## Projection holographique

- Pendant `drawing`, afficher le dessin seul : aucun mot, score, chrono, numéro de manche, aide ou chrome persistant.
- Une interruption réseau ou une salle expirée est l'exception : afficher une reprise minimale plutôt qu'une image figée indéfiniment.
- Les contrôles techniques apparaissent brièvement après interaction puis disparaissent. Obtenir un geste utilisateur avant fullscreen si le navigateur l'exige.
- Afficher informations, scores et consignes avant, entre et après les manches.
- Pré-inverser chaque face horizontalement pour que la réflexion physique restitue le bon sens; ne pas appliquer un miroir global qui inverse aussi les repères techniques de calibration.
- Ne proposer que le plexiglas en V : exactement deux faces carrées empilées dans un stage 1:2. Ce rendu correspond à l'ancienne composition horizontale tournée de 90° dans le sens horaire : face haute à 180°, face basse à 0°. Portrait et paysage gardent cette même composition; seule l'échelle change. Ne jamais verrouiller l'orientation ni afficher de consigne de rotation.
- Après `finished`, le contrôleur peut préparer une nouvelle partie avec les mêmes joueurs et réglages; les scores et l'historique des mots repartent de zéro.

## Style et accessibilité

- Viser une UI moderne, sobre, directe et chaleureuse. Réserver les animations/haptiques aux réussites, transitions de manche et résultats; respecter `prefers-reduced-motion`.
- Garantir des cibles tactiles d'au moins 44 x 44 px, un focus visible, les safe areas et les petits viewports.
- Les modales et feuilles ont focus initial, piège de focus, fermeture Escape, restauration du focus et arrière-plan non tabulable.
- Une seule copie sémantique des informations projetées; marquer les faces décoratives `aria-hidden`.
- Nommer le QR code, annoncer « points » et le dessinateur sans dépendre uniquement de la couleur.

## Validation visuelle ciblée

- Utiliser `src/client/App.tsx` pour la composition, `src/client/styles.css` pour le responsive et `src/client/drawing/` pour le canevas.
- Vérifier au minimum portrait mobile étroit, paysage mobile court et écran large; tester clavier, focus et offline/reconnexion.
- La réflexion, le plein écran, la rotation physique portrait/paysage, le QR et le Wake Lock restent à confirmer sur appareils réels. Consulter la section manuelle de `docs/quality-audit.md` seulement pour préparer cette recette.
