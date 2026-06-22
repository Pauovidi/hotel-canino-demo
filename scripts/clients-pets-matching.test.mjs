import { describe, expect, it } from "vitest";
import {
  CANONICAL_MATCH_STATUSES,
  DUPLICATE_STATUSES,
  MATCH_STATUSES,
  buildCanonicalClients,
  matchAnimalClient,
  matchAnimalClientCanonical,
} from "./clients-pets-matching.mjs";

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

describe("canonical clients pets matching", () => {
  it.each(["Mónica Martínez", "Antonio Fernández", "Marina Arnaut", "Mari Carmen"])(
    "deduplicates exact repeated client name %s",
    (name) => {
      const canonical = buildCanonicalClients([
        { rowNumber: 1, name, activo: "true" },
        { rowNumber: 2, name, activo: "true" },
      ]);

      expect(canonical).toHaveLength(1);
      expect(canonical[0].duplicateStatus).toBe(DUPLICATE_STATUSES.DUPLICATE_EXACT_NAME);
      expect(canonical[0].sourceClientRows).toHaveLength(2);
    },
  );

  it("keeps Pilar as ambiguous_canonical when several canonical clients share that token", () => {
    const canonical = buildCanonicalClients([
      { rowNumber: 1, name: "Pilar Molina" },
      { rowNumber: 2, name: "Pilar Garcia" },
    ]);
    const result = matchAnimalClientCanonical("Pilar", canonical);

    expect(result.status).toBe(CANONICAL_MATCH_STATUSES.AMBIGUOUS_CANONICAL);
    expect(result.matchMethod).toBe("incomplete_name_common");
  });

  it("keeps Marina as ambiguous_canonical when several canonical clients share that token", () => {
    const canonical = buildCanonicalClients([
      { rowNumber: 1, name: "Marina Arnaut" },
      { rowNumber: 2, name: "Marina Lopez" },
    ]);
    const result = matchAnimalClientCanonical("Marina", canonical);

    expect(result.status).toBe(CANONICAL_MATCH_STATUSES.AMBIGUOUS_CANONICAL);
    expect(result.matchMethod).toBe("incomplete_name_common");
  });

  it("matches MOLINA to unique ALEJANDRO MOLINA as probable_high_unique_token_canonical", () => {
    const canonical = buildCanonicalClients([
      { rowNumber: 1, name: "Alejandro Molina" },
      { rowNumber: 2, name: "Laura Garcia" },
    ]);
    const result = matchAnimalClientCanonical("Molina", canonical);

    expect(result.status).toBe(
      CANONICAL_MATCH_STATUSES.PROBABLE_HIGH_UNIQUE_TOKEN_CANONICAL,
    );
    expect(result.canonicalClient?.canonicalClientName).toBe("Alejandro Molina");
  });

  it("marks MOLINA as ambiguous_canonical with two Molina canonical clients", () => {
    const canonical = buildCanonicalClients([
      { rowNumber: 1, name: "Alejandro Molina" },
      { rowNumber: 2, name: "Marta Molina" },
    ]);
    const result = matchAnimalClientCanonical("Molina", canonical);

    expect(result.status).toBe(CANONICAL_MATCH_STATUSES.AMBIGUOUS_CANONICAL);
  });

  it("classifies RESERVAS as ignored_noise in canonical matching", () => {
    const canonical = buildCanonicalClients([{ rowNumber: 1, name: "Reservas Hotel" }]);
    const result = matchAnimalClientCanonical("Reservas", canonical);

    expect(result.status).toBe(CANONICAL_MATCH_STATUSES.IGNORED_NOISE);
  });

  it("marks duplicate candidates with blocked conflict as manual_review_conflict", () => {
    const canonical = buildCanonicalClients([
      { rowNumber: 1, name: "Mónica Martínez", bloqueadoNoReservar: "false" },
      { rowNumber: 2, name: "Mónica Martínez", bloqueadoNoReservar: "true" },
    ]);

    expect(canonical).toHaveLength(1);
    expect(canonical[0].duplicateStatus).toBe(DUPLICATE_STATUSES.MANUAL_REVIEW_CONFLICT);
  });
});
