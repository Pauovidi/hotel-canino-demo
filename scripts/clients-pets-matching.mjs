export const MATCH_STATUSES = {
  EXACT: "exact",
  TOKEN_SUBSET_UNIQUE: "token_subset_unique",
  PROBABLE_HIGH_UNIQUE_TOKEN: "probable_high_unique_token",
  AMBIGUOUS: "ambiguous",
  MISSING: "missing",
  IGNORED_NOISE: "ignored_noise",
};

export const NOISE_TERMS = new Set([
  "RESERVAS",
  "RESERVA",
  "CLIENTE",
  "CLIENTES",
  "SIN NOMBRE",
  "SIN DATOS",
  "DESCONOCIDO",
  "DESCONOCIDA",
  "PERRO",
  "PERRA",
  "FAMILIA",
  "CONTACTO",
  "URGENTE",
  "HOTEL",
  "GUARDERIA",
  "VARIOS",
  "VARIAS",
]);

export const HIGH_RISK_SINGLE_TOKENS = new Set([
  "ANA",
  "MARIA",
  "JOSE",
  "JUAN",
  "JORDI",
  "PACO",
  "FRANCISCO",
  "MANUEL",
  "ANTONIO",
  "LUIS",
  "LAURA",
  "MARTA",
  "CARMEN",
  "ROSA",
  "CRISTINA",
  "ALBA",
  "PAULA",
  "SARA",
  "DAVID",
  "CARLOS",
  "MIGUEL",
  "JAVIER",
  "SERGIO",
  "RAQUEL",
  "ELENA",
  "LUCIA",
  "PILAR",
  "ISABEL",
  "AIDA",
  "ALEX",
  "ALEJANDRO",
  "ALEXANDRA",
]);

function stripDiacriticsKeepingEnye(value) {
  return value
    .replace(/Ñ/g, "__ENYE_UPPER__")
    .replace(/ñ/g, "__ENYE_LOWER__")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/__ENYE_UPPER__/g, "Ñ")
    .replace(/__ENYE_LOWER__/g, "Ñ");
}

export function normalizeName(value) {
  return stripDiacriticsKeepingEnye(String(value ?? ""))
    .toUpperCase()
    .replace(/[^\p{L}\p{N}\sÑ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeName(value) {
  const normalized = normalizeName(value);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !NOISE_TERMS.has(token));
}

export function isNoiseName(value) {
  const normalized = normalizeName(value);
  return !normalized || NOISE_TERMS.has(normalized) || tokenizeName(normalized).length === 0;
}

export function prepareClientCandidate(client) {
  const normalizedName = normalizeName(client.name ?? client.nombre);
  const tokens = tokenizeName(normalizedName);
  return {
    ...client,
    name: client.name ?? client.nombre,
    normalizedName,
    tokens,
    tokenSet: new Set(tokens),
  };
}

function summarizeCandidates(candidates) {
  return candidates.map((client) => ({
    row: client.rowNumber ?? client.CSV_ROW_CLIENTES ?? client.csvRow,
    name: client.name,
    normalizedName: client.normalizedName,
  }));
}

export function matchAnimalClient(animalClientName, rawClients) {
  const normalizedName = normalizeName(animalClientName);
  const usefulTokens = tokenizeName(animalClientName);
  const clients = rawClients.map(prepareClientCandidate);

  if (isNoiseName(animalClientName)) {
    return {
      status: MATCH_STATUSES.IGNORED_NOISE,
      normalizedName,
      usefulTokens,
      candidates: [],
    };
  }

  const exactCandidates = clients.filter((client) => client.normalizedName === normalizedName);
  if (exactCandidates.length === 1) {
    return {
      status: MATCH_STATUSES.EXACT,
      normalizedName,
      usefulTokens,
      client: exactCandidates[0],
      candidates: summarizeCandidates(exactCandidates),
    };
  }
  if (exactCandidates.length > 1) {
    return {
      status: MATCH_STATUSES.AMBIGUOUS,
      normalizedName,
      usefulTokens,
      candidates: summarizeCandidates(exactCandidates),
      matchMethod: MATCH_STATUSES.EXACT,
    };
  }

  if (usefulTokens.length >= 2) {
    const subsetCandidates = clients.filter((client) =>
      usefulTokens.every((token) => client.tokenSet.has(token)),
    );
    if (subsetCandidates.length === 1) {
      return {
        status: MATCH_STATUSES.TOKEN_SUBSET_UNIQUE,
        normalizedName,
        usefulTokens,
        tokenMatch: usefulTokens.join(" "),
        client: subsetCandidates[0],
        candidates: summarizeCandidates(subsetCandidates),
      };
    }
    if (subsetCandidates.length > 1) {
      return {
        status: MATCH_STATUSES.AMBIGUOUS,
        normalizedName,
        usefulTokens,
        tokenMatch: usefulTokens.join(" "),
        candidates: summarizeCandidates(subsetCandidates),
        matchMethod: MATCH_STATUSES.TOKEN_SUBSET_UNIQUE,
      };
    }
  }

  if (usefulTokens.length === 1) {
    const [token] = usefulTokens;
    if (token.length >= 4 && !NOISE_TERMS.has(token) && !HIGH_RISK_SINGLE_TOKENS.has(token)) {
      const tokenCandidates = clients.filter((client) => client.tokenSet.has(token));
      if (tokenCandidates.length === 1) {
        return {
          status: MATCH_STATUSES.PROBABLE_HIGH_UNIQUE_TOKEN,
          normalizedName,
          usefulTokens,
          tokenMatch: token,
          client: tokenCandidates[0],
          candidates: summarizeCandidates(tokenCandidates),
        };
      }
      if (tokenCandidates.length > 1) {
        return {
          status: MATCH_STATUSES.AMBIGUOUS,
          normalizedName,
          usefulTokens,
          tokenMatch: token,
          candidates: summarizeCandidates(tokenCandidates),
          matchMethod: MATCH_STATUSES.PROBABLE_HIGH_UNIQUE_TOKEN,
        };
      }
    }
  }

  return {
    status: MATCH_STATUSES.MISSING,
    normalizedName,
    usefulTokens,
    candidates: [],
  };
}

export function chatbotRuleForPetCount(count, status) {
  if (
    status === MATCH_STATUSES.EXACT ||
    status === MATCH_STATUSES.TOKEN_SUBSET_UNIQUE ||
    status === MATCH_STATUSES.PROBABLE_HIGH_UNIQUE_TOKEN
  ) {
    return count === 1 ? "known_client_single_pet_auto_dates" : "known_client_multiple_pets_ask_which";
  }
  return "ask_pet_name";
}
