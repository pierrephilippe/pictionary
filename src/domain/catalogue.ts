import type { Difficulty, Theme, Word } from "./types";

type WordSeed = readonly [string, Theme, Difficulty];

const seeds: WordSeed[] = [
  ["chat", "animaux", "facile"], ["chien", "animaux", "facile"], ["poisson", "animaux", "facile"],
  ["girafe", "animaux", "moyen"], ["papillon", "animaux", "moyen"], ["pingouin", "animaux", "moyen"],
  ["caméléon", "animaux", "difficile"], ["ornithorynque", "animaux", "difficile"], ["mille-pattes", "animaux", "difficile"],
  ["chaise", "objets", "facile"], ["ballon", "objets", "facile"], ["clé", "objets", "facile"],
  ["parapluie", "objets", "moyen"], ["téléphone", "objets", "moyen"], ["guitare", "objets", "moyen"],
  ["sablier", "objets", "difficile"], ["téléscope", "objets", "difficile"], ["boomerang", "objets", "difficile"],
  ["pomme", "alimentation", "facile"], ["pizza", "alimentation", "facile"], ["glace", "alimentation", "facile"],
  ["croissant", "alimentation", "moyen"], ["sushi", "alimentation", "moyen"], ["pastèque", "alimentation", "moyen"],
  ["artichaut", "alimentation", "difficile"], ["baguettes", "alimentation", "difficile"], ["fondue", "alimentation", "difficile"],
  ["maison", "lieux", "facile"], ["plage", "lieux", "facile"], ["école", "lieux", "facile"],
  ["aéroport", "lieux", "moyen"], ["château", "lieux", "moyen"], ["cinéma", "lieux", "moyen"],
  ["phare", "lieux", "difficile"], ["observatoire", "lieux", "difficile"], ["montgolfière", "lieux", "difficile"],
  ["pompier", "metiers", "facile"], ["boulanger", "metiers", "facile"], ["docteur", "metiers", "facile"],
  ["photographe", "metiers", "moyen"], ["astronaute", "metiers", "moyen"], ["jardinier", "metiers", "moyen"],
  ["archéologue", "metiers", "difficile"], ["chef d’orchestre", "metiers", "difficile"], ["funambule", "metiers", "difficile"],
];

export const CATALOGUE: Word[] = seeds.map(([label, theme, difficulty], index) => ({
  id: `word-${index + 1}`,
  label,
  theme,
  difficulty,
}));
