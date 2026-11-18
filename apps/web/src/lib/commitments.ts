/** Commitment keys; every strategy has its own set. */
export const COMMITMENT_KEYS: Record<string, string> = {
  max_real_capital: "Maksymalna kwota na realne konto dla tej strategii (bez dopłacania)",
  real_account_conditions: "Warunki przejścia tej strategii na realne konto",
  project_end_condition: "Kiedy kończę tę strategię",
  project_end_date: "Data ostatecznej oceny strategii",
  other: "Inne",
};

export const COMMITMENT_PLACEHOLDER: Record<string, string> = {
  max_real_capital: "np. 2000 zł, bez dopłat",
  real_account_conditions: "np. spełnione kryteria sukcesu przez 2 kolejne przeglądy",
  project_end_condition: "np. jeśli po 4 miesiącach demo strategia nie spełni kryteriów, wycofuję ją",
  project_end_date: "np. 31.03.2027",
};

export const COMMITMENT_SHORT: Record<string, string> = {
  max_real_capital: "Maks. kapitał realny",
  real_account_conditions: "Warunki konta realnego",
  project_end_condition: "Kiedy kończę",
  project_end_date: "Data oceny",
  other: "Inne",
};
