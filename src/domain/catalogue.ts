import { DIFFICULTIES, THEMES, type Difficulty, type Theme, type Word } from "./types";

type PromptsByTheme = Record<Theme, readonly string[]>;

// Les cinquante bases de chaque thème constituent les niveaux facile et moyen.
// Le niveau difficile les combine avec des situations très visuelles : le résultat
// reste simple à dessiner tout en donnant plus de 3 000 cartes distinctes au jeu.
const basePrompts: PromptsByTheme = {
  animaux: [
    "chat", "chien", "poisson", "cheval", "lapin", "vache", "mouton", "cochon", "poule", "canard",
    "grenouille", "lion", "tigre", "éléphant", "girafe", "singe", "panda", "dauphin", "requin", "tortue",
    "escargot", "abeille", "papillon", "coccinelle", "serpent", "loup", "renard", "ours", "crocodile", "zèbre",
    "pingouin", "kangourou", "koala", "hibou", "aigle", "flamant rose", "chameau", "dromadaire", "rhinocéros", "hippopotame",
    "gorille", "paon", "autruche", "pieuvre", "méduse", "homard", "crabe", "caméléon", "ornithorynque", "mille-pattes",
  ],
  objets: [
    "chaise", "ballon", "clé", "livre", "tasse", "lampe", "vélo", "brosse", "montre", "chapeau",
    "parapluie", "téléphone", "guitare", "valise", "appareil photo", "lunettes", "bouteille", "ciseaux", "marteau", "horloge",
    "sac à dos", "bougie", "raquette", "trottinette", "casque", "tablette", "ordinateur", "micro", "crayon", "pinceau",
    "échelle", "aspirateur", "télécommande", "fer à repasser", "cafetière", "grille-pain", "machine à coudre", "microscope", "jumelles", "boussole",
    "sablier", "boomerang", "frisbee", "skateboard", "drone", "réveil", "tirelire", "projecteur", "télescope", "puzzle",
  ],
  alimentation: [
    "pomme", "pizza", "glace", "pain", "fromage", "gâteau", "banane", "carotte", "fraise", "hamburger",
    "sushi", "croissant", "pastèque", "raisin", "citron", "tomate", "œuf", "chocolat", "soupe", "crêpe",
    "sandwich", "salade", "cerise", "poire", "ananas", "melon", "kiwi", "avocat", "orange", "framboise",
    "champignon", "donut", "pop-corn", "baguette", "yaourt", "tartine", "artichaut", "fondue", "couscous", "lasagnes",
    "bretzel", "macarons", "raviolis", "burrito", "hot-dog", "pancake", "sorbet", "confiture", "muffin", "tacos",
  ],
  lieux: [
    "maison", "plage", "école", "parc", "ferme", "zoo", "magasin", "hôpital", "gare", "musée",
    "cinéma", "restaurant", "bibliothèque", "stade", "jardin", "piscine", "aéroport", "château", "phare", "montagne",
    "forêt", "désert", "île", "volcan", "aquarium", "cirque", "port", "marché", "hôtel", "camping",
    "station de ski", "boulangerie", "garage", "théâtre", "opéra", "laboratoire", "observatoire", "planétarium", "pyramide", "temple",
    "pont", "tunnel", "métro", "station spatiale", "cabane", "gratte-ciel", "ranch", "igloo", "bateau pirate", "cascade",
  ],
  metiers: [
    "pompier", "boulanger", "docteur", "jardinier", "policier", "professeur", "cuisinier", "coiffeur", "peintre", "pilote",
    "infirmier", "facteur", "fermier", "dentiste", "mécanicien", "plombier", "électricien", "photographe", "musicien", "danseur",
    "acteur", "astronaute", "archéologue", "vétérinaire", "scientifique", "architecte", "journaliste", "avocat", "juge", "libraire",
    "serveur", "pâtissier", "fleuriste", "maçon", "couturier", "marin", "pêcheur", "plongeur", "sauveteur", "magicien",
    "chef d’orchestre", "funambule", "sculpteur", "dessinateur", "cartographe", "horloger", "apiculteur", "pilote de course", "glacier", "acrobate",
  ],
};

const difficultQualifiers: PromptsByTheme = {
  animaux: ["avec un chapeau", "sur un skateboard", "dans une fusée", "sous la pluie", "sur la lune", "avec des ailes", "dans un château", "à rayures", "avec un parapluie", "en train de danser", "sur un arc-en-ciel", "sous l’eau"],
  objets: ["géant", "minuscule", "dans l’espace", "sous la pluie", "avec des ailes", "à pois", "en chocolat", "sur la lune", "dans un aquarium", "à roulettes", "en glace", "dans un château"],
  alimentation: ["géant", "minuscule", "volant", "sur la lune", "avec des ailes", "dans un aquarium", "à pois", "en glace", "dans l’espace", "sur un skateboard", "sous la pluie", "dans un château"],
  lieux: ["sous la neige", "dans l’espace", "sous l’eau", "sur la lune", "avec un arc-en-ciel", "avec des dinosaures", "en chocolat", "dans les nuages", "sur un volcan", "la nuit", "avec un robot", "dans une tempête"],
  metiers: ["sur un skateboard", "dans l’espace", "sous l’eau", "sur la lune", "avec un dragon", "dans une tempête", "sur un arc-en-ciel", "dans un château", "avec un parapluie", "en train de danser", "sur un monocycle", "avec un robot"],
};

const makeSeeds = (): Array<readonly [string, Theme, Difficulty]> => THEMES.flatMap((theme) => {
  const prompts = basePrompts[theme];
  if (prompts.length !== 50) throw new Error(`Le thème ${theme} doit contenir 50 mots de base.`);
  return [
    ...prompts.slice(0, 25).map((label) => [label, theme, "facile"] as const),
    ...prompts.slice(25).map((label) => [label, theme, "moyen"] as const),
    ...prompts.flatMap((label) => difficultQualifiers[theme].map((qualifier) => [`${label} ${qualifier}`, theme, "difficile"] as const)),
  ];
});

const seeds = makeSeeds();

export const CATALOGUE: Word[] = seeds.map(([label, theme, difficulty], index) => ({
  id: `word-${index + 1}`,
  label,
  theme,
  difficulty,
}));

export const CATALOGUE_SIZE = CATALOGUE.length;

// Conserver ce garde-fou près des données rend une réduction accidentelle du
// catalogue immédiatement visible en développement et dans les tests.
if (CATALOGUE_SIZE < 3_000) throw new Error("Le catalogue doit contenir au moins 3 000 mots.");

export { DIFFICULTIES, THEMES };
