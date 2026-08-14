import dictionary from "./data/dictionary.fr.json";
import { DIFFICULTIES, THEMES, type Difficulty, type Theme, type Word } from "./types";

type PromptsByTheme = Record<Theme, Record<Difficulty, readonly string[]>>;

interface Dictionary {
  prompts: PromptsByTheme;
}

const prompts = dictionary as Dictionary;
const PROMPTS_PER_DIFFICULTY = 75;
const PROMPT_BATCH_SIZE = 25;

const makeSeeds = (offset: number): Array<readonly [string, Theme, Difficulty]> => THEMES.flatMap((theme) => {
  const themePrompts = prompts.prompts[theme];
  const easyPrompts = themePrompts.facile.slice(offset, offset + PROMPT_BATCH_SIZE);
  const mediumPrompts = themePrompts.moyen.slice(offset, offset + PROMPT_BATCH_SIZE);
  const batchPrompts = [...easyPrompts, ...mediumPrompts];

  if (themePrompts.facile.length !== PROMPTS_PER_DIFFICULTY || themePrompts.moyen.length !== PROMPTS_PER_DIFFICULTY) {
    throw new Error(`Le thème ${theme} doit contenir ${PROMPTS_PER_DIFFICULTY} mots faciles et moyens.`);
  }
  if (batchPrompts.length !== PROMPT_BATCH_SIZE * 2 || themePrompts.difficile.length !== 12) {
    throw new Error(`Le thème ${theme} contient une sélection de mots ou de qualificatifs incomplète.`);
  }

  return [
    ...easyPrompts.map((label) => [label, theme, "facile"] as const),
    ...mediumPrompts.map((label) => [label, theme, "moyen"] as const),
    ...batchPrompts.flatMap((label) => themePrompts.difficile.map((qualifier) => [`${label} ${qualifier}`, theme, "difficile"] as const)),
  ];
});

// Les lots préservent l'ordre historique des cartes, tandis que le dictionnaire
// reste organisé simplement par thème puis par difficulté.
const seeds = Array.from({ length: PROMPTS_PER_DIFFICULTY / PROMPT_BATCH_SIZE }, (_, index) => makeSeeds(index * PROMPT_BATCH_SIZE)).flat();

export const CATALOGUE: Word[] = seeds.map(([label, theme, difficulty], index) => ({
  id: `word-${index + 1}`,
  label,
  theme,
  difficulty,
}));

export const CATALOGUE_SIZE = CATALOGUE.length;

if (CATALOGUE_SIZE < 9_750) throw new Error("Le catalogue doit contenir au moins 9 750 mots.");

export { DIFFICULTIES, THEMES };
