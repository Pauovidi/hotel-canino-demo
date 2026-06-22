export const MATCH_STATUSES = {
  EXACT: "exact",
  TOKEN_SUBSET_UNIQUE: "token_subset_unique",
  PROBABLE_HIGH_UNIQUE_TOKEN: "probable_high_unique_token",
  AMBIGUOUS: "ambiguous",
  MISSING: "missing",
  IGNORED_NOISE: "ignored_noise",
};

export const CANONICAL_MATCH_STATUSES = {
  EXACT_CANONICAL: "exact_canonical",
  TOKEN_SUBSET_UNIQUE_CANONICAL: "token_subset_unique_canonical",
  PROBABLE_HIGH_UNIQUE_TOKEN_CANONICAL: "probable_high_unique_token_canonical",
  DUPLICATE_CLEAR_CANONICAL: "duplicate_clear_canonical",
  AMBIGUOUS_CANONICAL: "ambiguous_canonical",
  MISSING: "missing",
  IGNORED_NOISE: "ignored_noise",
};

export const DUPLICATE_STATUSES = {
  UNIQUE: "unique",
  DUPLICATE_EXACT_NAME: "duplicate_exact_name",
  DUPLICATE_SAME_PHONE: "duplicate_same_phone",
  DUPLICATE_SAME_EMAIL: "duplicate_same_email",
  PROBABLE_DUPLICATE_NAME_VARIANT: "probable_duplicate_name_variant",
  MANUAL_REVIEW_CONFLICT: "manual_review_conflict",
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
  "MARINA",
  "CARMEN",
  "MARI",
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

const TRUE_VALUES = new Set(["1", "TRUE", "SI", "SÍ", "YES", "Y", "X"]);

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

function normalizePhoneValue(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 6 ? digits : "";
}

function normalizeEmailValue(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isTruthyValue(value) {
  return TRUE_VALUES.has(normalizeName(value));
}

function clientHasCriticalConflict(clients) {
  const blockedValues = new Set(clients.map((client) => isTruthyValue(client.bloqueadoNoReservar)));
  return blockedValues.size > 1;
}

function canonicalScore(client) {
  return (
    (isTruthyValue(client.activo) ? 100 : 0) +
    (normalizePhoneValue(client.phone ?? client.telefonoNormalizado ?? client.telefonoMovil) ? 20 : 0) +
    (normalizeEmailValue(client.email) ? 10 : 0) +
    tokenizeName(client.name).length * 2 +
    normalizeName(client.name).length / 100
  );
}

class UnionFind {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index) {
    if (this.parent[index] !== index) {
      this.parent[index] = this.find(this.parent[index]);
    }
    return this.parent[index];
  }

  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) {
      this.parent[rightRoot] = leftRoot;
    }
  }
}

function unionByKey(items, readKey, unionFind) {
  const seen = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const key = readKey(items[index]);
    if (!key) {
      continue;
    }
    if (seen.has(key)) {
      unionFind.union(seen.get(key), index);
    } else {
      seen.set(key, index);
    }
  }
}

function groupDuplicateReason(clients) {
  if (clientHasCriticalConflict(clients)) {
    return {
      duplicateStatus: DUPLICATE_STATUSES.MANUAL_REVIEW_CONFLICT,
      duplicateConfidence: "manual_review",
      duplicateReason: "Conflicto en bloqueo/no reservar entre filas similares.",
    };
  }

  const phones = new Set(
    clients.map((client) => normalizePhoneValue(client.phone ?? client.telefonoNormalizado ?? client.telefonoMovil)).filter(Boolean),
  );
  const emails = new Set(clients.map((client) => normalizeEmailValue(client.email)).filter(Boolean));
  const names = new Set(clients.map((client) => client.normalizedName).filter(Boolean));

  if (phones.size > 0) {
    return {
      duplicateStatus: DUPLICATE_STATUSES.DUPLICATE_SAME_PHONE,
      duplicateConfidence: "high",
      duplicateReason: "Mismo telefono normalizado en varias filas.",
    };
  }
  if (emails.size > 0) {
    return {
      duplicateStatus: DUPLICATE_STATUSES.DUPLICATE_SAME_EMAIL,
      duplicateConfidence: "high",
      duplicateReason: "Mismo email en varias filas.",
    };
  }
  if (names.size === 1) {
    return {
      duplicateStatus: DUPLICATE_STATUSES.DUPLICATE_EXACT_NAME,
      duplicateConfidence: "high",
      duplicateReason: "Mismo nombre normalizado exacto en CLIENTES.",
    };
  }
  return {
    duplicateStatus: DUPLICATE_STATUSES.PROBABLE_DUPLICATE_NAME_VARIANT,
    duplicateConfidence: "medium",
    duplicateReason: "Variantes de nombre agrupadas por datos coincidentes.",
  };
}

export function buildCanonicalClients(rawClients) {
  const clients = rawClients.map((client, index) => ({
    ...prepareClientCandidate(client),
    sourceIndex: index,
    rowNumber: client.rowNumber ?? client.CSV_ROW_CLIENTES ?? client.csvRow ?? String(index + 2),
    phone: client.phone ?? client.telefonoNormalizado ?? client.telefonoMovil ?? "",
    email: client.email ?? "",
  }));
  const unionFind = new UnionFind(clients.length);

  unionByKey(clients, (client) => client.normalizedName, unionFind);
  unionByKey(clients, (client) => normalizePhoneValue(client.phone), unionFind);
  unionByKey(clients, (client) => normalizeEmailValue(client.email), unionFind);

  const grouped = new Map();
  clients.forEach((client, index) => {
    const root = unionFind.find(index);
    grouped.set(root, [...(grouped.get(root) ?? []), client]);
  });

  return Array.from(grouped.values()).map((group, index) => {
    const canonical = [...group].sort((a, b) => canonicalScore(b) - canonicalScore(a))[0];
    const duplicate = group.length > 1
      ? groupDuplicateReason(group)
      : {
          duplicateStatus: DUPLICATE_STATUSES.UNIQUE,
          duplicateConfidence: "single",
          duplicateReason: "Fila unica en CLIENTES.",
        };
    const allTokens = Array.from(new Set(group.flatMap((client) => client.tokens)));
    const allNames = Array.from(new Set(group.map((client) => client.name).filter(Boolean)));
    const canonicalClient = {
      canonicalClientId: `CAN-${String(index + 1).padStart(5, "0")}`,
      canonicalClientName: canonical.name,
      duplicateGroupId: `DUP-${String(index + 1).padStart(5, "0")}`,
      sourceClientRows: group.map((client) => String(client.rowNumber)),
      sourceClientNames: allNames,
      sourceClients: group,
      canonicalRow: canonical.rowNumber,
      canonicalPhone: canonical.phone,
      canonicalEmail: canonical.email,
      normalizedName: normalizeName(canonical.name),
      tokens: allTokens,
      tokenSet: new Set(allTokens),
      ...duplicate,
    };
    return canonicalClient;
  });
}

function summarizeCanonicalCandidates(candidates) {
  return candidates.map((client) => ({
    canonicalClientId: client.canonicalClientId,
    canonicalClientName: client.canonicalClientName,
    duplicateStatus: client.duplicateStatus,
    sourceClientRows: client.sourceClientRows,
  }));
}

function canonicalMatchStatus(baseStatus, canonical) {
  if (
    canonical.sourceClientRows.length > 1 &&
    canonical.duplicateStatus !== DUPLICATE_STATUSES.MANUAL_REVIEW_CONFLICT
  ) {
    return CANONICAL_MATCH_STATUSES.DUPLICATE_CLEAR_CANONICAL;
  }
  return baseStatus;
}

export function matchAnimalClientCanonical(animalClientName, canonicalClients) {
  const normalizedName = normalizeName(animalClientName);
  const usefulTokens = tokenizeName(animalClientName);

  if (isNoiseName(animalClientName)) {
    return {
      status: CANONICAL_MATCH_STATUSES.IGNORED_NOISE,
      normalizedName,
      usefulTokens,
      candidates: [],
    };
  }

  const exactCandidates = canonicalClients.filter(
    (client) =>
      client.normalizedName === normalizedName ||
      client.sourceClients.some((sourceClient) => sourceClient.normalizedName === normalizedName),
  );
  if (exactCandidates.length === 1) {
    const client = exactCandidates[0];
    return {
      status: canonicalMatchStatus(CANONICAL_MATCH_STATUSES.EXACT_CANONICAL, client),
      normalizedName,
      usefulTokens,
      canonicalClient: client,
      candidates: summarizeCanonicalCandidates(exactCandidates),
    };
  }
  if (exactCandidates.length > 1) {
    return {
      status: CANONICAL_MATCH_STATUSES.AMBIGUOUS_CANONICAL,
      normalizedName,
      usefulTokens,
      candidates: summarizeCanonicalCandidates(exactCandidates),
      matchMethod: CANONICAL_MATCH_STATUSES.EXACT_CANONICAL,
    };
  }

  if (usefulTokens.length >= 2) {
    const subsetCandidates = canonicalClients.filter((client) =>
      usefulTokens.every((token) => client.tokenSet.has(token)),
    );
    if (subsetCandidates.length === 1) {
      const client = subsetCandidates[0];
      return {
        status: canonicalMatchStatus(CANONICAL_MATCH_STATUSES.TOKEN_SUBSET_UNIQUE_CANONICAL, client),
        normalizedName,
        usefulTokens,
        tokenMatch: usefulTokens.join(" "),
        canonicalClient: client,
        candidates: summarizeCanonicalCandidates(subsetCandidates),
      };
    }
    if (subsetCandidates.length > 1) {
      return {
        status: CANONICAL_MATCH_STATUSES.AMBIGUOUS_CANONICAL,
        normalizedName,
        usefulTokens,
        tokenMatch: usefulTokens.join(" "),
        candidates: summarizeCanonicalCandidates(subsetCandidates),
        matchMethod: CANONICAL_MATCH_STATUSES.TOKEN_SUBSET_UNIQUE_CANONICAL,
      };
    }
  }

  if (usefulTokens.length === 1) {
    const [token] = usefulTokens;
    const tokenCandidates = canonicalClients.filter((client) => client.tokenSet.has(token));
    if (tokenCandidates.length > 1) {
      return {
        status: CANONICAL_MATCH_STATUSES.AMBIGUOUS_CANONICAL,
        normalizedName,
        usefulTokens,
        tokenMatch: token,
        candidates: summarizeCanonicalCandidates(tokenCandidates),
        matchMethod: HIGH_RISK_SINGLE_TOKENS.has(token)
          ? "incomplete_name_common"
          : CANONICAL_MATCH_STATUSES.PROBABLE_HIGH_UNIQUE_TOKEN_CANONICAL,
      };
    }
    if (
      tokenCandidates.length === 1 &&
      token.length >= 4 &&
      !NOISE_TERMS.has(token) &&
      !HIGH_RISK_SINGLE_TOKENS.has(token)
    ) {
      const client = tokenCandidates[0];
      return {
        status: canonicalMatchStatus(
          CANONICAL_MATCH_STATUSES.PROBABLE_HIGH_UNIQUE_TOKEN_CANONICAL,
          client,
        ),
        normalizedName,
        usefulTokens,
        tokenMatch: token,
        canonicalClient: client,
        candidates: summarizeCanonicalCandidates(tokenCandidates),
      };
    }
  }

  return {
    status: CANONICAL_MATCH_STATUSES.MISSING,
    normalizedName,
    usefulTokens,
    candidates: [],
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
    status === MATCH_STATUSES.PROBABLE_HIGH_UNIQUE_TOKEN ||
    status === CANONICAL_MATCH_STATUSES.EXACT_CANONICAL ||
    status === CANONICAL_MATCH_STATUSES.TOKEN_SUBSET_UNIQUE_CANONICAL ||
    status === CANONICAL_MATCH_STATUSES.PROBABLE_HIGH_UNIQUE_TOKEN_CANONICAL ||
    status === CANONICAL_MATCH_STATUSES.DUPLICATE_CLEAR_CANONICAL
  ) {
    return count === 1 ? "known_client_single_pet_auto_dates" : "known_client_multiple_pets_ask_which";
  }
  return "ask_pet_name";
}
