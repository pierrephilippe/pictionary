import dictionary from "./data/dictionary.fr.json";
import { DIFFICULTIES, THEMES, type Difficulty, type Theme, type Word } from "./types";

type PromptsByTheme = Record<Theme, Record<Difficulty, readonly string[]>>;

interface Dictionary {
  prompts: PromptsByTheme;
}

const { prompts } = dictionary as Dictionary;
const MIN_PROMPTS_PER_DIFFICULTY = 75;
const labelsByDifficulty = new Map<Difficulty, Map<string, Theme>>(
  DIFFICULTIES.map((difficulty) => [difficulty, new Map<string, Theme>()]),
);

const stableHash = (value: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (const character of value.normalize("NFC")) {
    hash ^= BigInt(character.codePointAt(0)!);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
};

export const wordIdFor = (label: string, theme: Theme, difficulty: Difficulty): string =>
  `word-${theme}-${difficulty}-${stableHash(`${theme}\u0000${difficulty}\u0000${label.trim().toLocaleLowerCase("fr")}`)}`;

const seeds: Array<readonly [string, Theme, Difficulty]> = THEMES.flatMap((theme) => {
  const themePrompts = prompts[theme];
  const labels = new Set<string>();

  return DIFFICULTIES.flatMap((difficulty) => {
    const difficultyPrompts = themePrompts[difficulty];
    if (difficultyPrompts.length < MIN_PROMPTS_PER_DIFFICULTY) {
      throw new Error(`Le thème ${theme} doit contenir au moins ${MIN_PROMPTS_PER_DIFFICULTY} entrées ${difficulty}.`);
    }

    return difficultyPrompts.map((label) => {
      const normalizedLabel = label.trim().toLocaleLowerCase("fr");
      if (!normalizedLabel) throw new Error(`Le thème ${theme} contient une entrée vide.`);
      if (labels.has(normalizedLabel)) throw new Error(`Le thème ${theme} contient l’entrée en double « ${label} ».`);
      const previousTheme = labelsByDifficulty.get(difficulty)!.get(normalizedLabel);
      if (previousTheme) throw new Error(`Les thèmes ${previousTheme} et ${theme} contiennent la même entrée ${difficulty} « ${label} ».`);
      labels.add(normalizedLabel);
      labelsByDifficulty.get(difficulty)!.set(normalizedLabel, theme);
      return [label, theme, difficulty] as const;
    });
  });
});

export const CATALOGUE: Word[] = seeds.map(([label, theme, difficulty]) => ({
  id: wordIdFor(label, theme, difficulty),
  label,
  theme,
  difficulty,
}));

export const CATALOGUE_SIZE = CATALOGUE.length;
if (new Set(CATALOGUE.map((word) => word.id)).size !== CATALOGUE_SIZE) throw new Error("Le catalogue contient une collision d’identifiants.");

const MIN_CATALOGUE_SIZE = THEMES.length * DIFFICULTIES.length * MIN_PROMPTS_PER_DIFFICULTY;
if (CATALOGUE_SIZE < MIN_CATALOGUE_SIZE) throw new Error(`Le catalogue doit contenir au moins ${MIN_CATALOGUE_SIZE} entrées.`);

export { DIFFICULTIES, THEMES };
