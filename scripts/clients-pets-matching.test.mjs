import { describe, expect, it } from "vitest";
import { MATCH_STATUSES, matchAnimalClient } from "./clients-pets-matching.mjs";

describe("clients pets matching", () => {
  it("matches MOLINA to the unique ALEJANDRO MOLINA as probable_high_unique_token", () => {
    const result = matchAnimalClient("Molina", [
      { rowNumber: 1, name: "Alejandro Molina" },
      { rowNumber: 2, name: "Laura Garcia" },
    ]);

    expect(result.status).toBe(MATCH_STATUSES.PROBABLE_HIGH_UNIQUE_TOKEN);
    expect(result.client?.name).toBe("Alejandro Molina");
    expect(result.tokenMatch).toBe("MOLINA");
  });

  it("marks MOLINA as ambiguous when two CLIENTES rows contain MOLINA", () => {
    const result = matchAnimalClient("Molina", [
      { rowNumber: 1, name: "Alejandro Molina" },
      { rowNumber: 2, name: "Marta Molina" },
    ]);

    expect(result.status).toBe(MATCH_STATUSES.AMBIGUOUS);
    expect(result.candidates).toHaveLength(2);
  });

  it("does not promote AIDA alone because it is a high-risk common token", () => {
    const result = matchAnimalClient("Aida", [
      { rowNumber: 1, name: "Aida Oller Hernandez" },
    ]);

    expect(result.status).toBe(MATCH_STATUSES.MISSING);
  });

  it("matches AIDA OLLER to AIDA OLLER HERNANDEZ as token_subset_unique", () => {
    const result = matchAnimalClient("Aida Oller", [
      { rowNumber: 1, name: "Aida Oller Hernandez" },
      { rowNumber: 2, name: "Aida Gomez" },
    ]);

    expect(result.status).toBe(MATCH_STATUSES.TOKEN_SUBSET_UNIQUE);
    expect(result.client?.name).toBe("Aida Oller Hernandez");
  });

  it("classifies RESERVAS as ignored_noise", () => {
    const result = matchAnimalClient("Reservas", [{ rowNumber: 1, name: "Reservas Hotel" }]);

    expect(result.status).toBe(MATCH_STATUSES.IGNORED_NOISE);
  });

  it("matches one exact full normalized name as exact", () => {
    const result = matchAnimalClient("María Núñez", [{ rowNumber: 1, name: "Maria Núñez" }]);

    expect(result.status).toBe(MATCH_STATUSES.EXACT);
    expect(result.client?.name).toBe("Maria Núñez");
  });
});
